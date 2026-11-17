import { headers } from '~/utils/helper';
import { OpenAIMessage } from "~/utils/types";
import { GoogleGenAI } from '@google/genai';

/**
 * Gemini Enterprise Agent Platform（Vertex AI）调用
 *
 * 关键点（与旧版的差异，务必先升级依赖）：
 *   package.json -> "@google/genai": "^3.4.0"    （最低要求 >= 2.32.0，2.13.0 不支持以下写法）
 *
 * 旧版写法 vertexai: { project, location } 是无效的：
 *   vertexai 只接受 boolean，传对象时被当成 true，project/location 被静默丢弃，
 *   于是请求走了「Express 无项目端点」，服务端按就近路由（国内 -> asia-southeast1），
 *   而 gemini-4-hydrogen 只在 global / us / eu 可用，因此必然 404。
 *
 * 新版：enterprise(等价 vertexai) 作开关，project 与 location 必须放顶层。
 *   SDK 3.x 会同时保留 apiKey 并用 x-goog-api-key 认证，
 *   请求打到 https://aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/...
 */
export default defineEventHandler(async (event) => {
    const apiKey = process.env.G_API_KEY;
    const projectId = process.env.GCP_PROJECT_ID;
    // gemini-4-hydrogen 仅支持 global / us / eu，不要写成 asia-southeast1 等区域端点
    const location = process.env.GCP_LOCATION || 'global';
    // 4 系默认思考等级是 HIGH，首字会明显变慢；这里默认压到 LOW，可用环境变量覆盖
    const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || 'HIGH';
    // 历史压缩用的模型
    const summaryModel = process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.8-flash';
    // 可选兜底：把服务账号 JSON 整段塞进 Vercel 环境变量（API key 无权访问项目端点时用）
    const saJson = process.env.GCP_SA_JSON;

    if (!apiKey && !saJson) {
        return new Response('未配置 G_API_KEY 环境变量', { status: 500 });
    }

    const body = await readFormData(event);
    const model = (body.get('model') as string) || 'gemini-4-hydrogen';
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'));
    const files = body.getAll('files') as File[];

    // gemini-4 系只存在于 global / us / eu，必须走带项目的端点。
    // 没配 GCP_PROJECT_ID 时会退化成 Express 无项目端点（服务端就近路由，必然 404），提前拦掉。
    if (/^gemini-4/i.test(model) && !projectId && !saJson) {
        return new Response(
            'gemini-4-hydrogen 需要显式区域端点（global/us/eu），请在 Vercel 环境变量中配置 GCP_PROJECT_ID'
            + '（本项目的项目号是 349229707532），仅靠 Express 无项目端点无法指定区域。',
            { status: 500 }
        );
    }

    // -----------------------------------------------------------------
    // 客户端初始化：保持原有的 API key 方式，只修正参数层级
    // -----------------------------------------------------------------
    let ai: GoogleGenAI;
    if (saJson && projectId) {
        // 备选：服务账号凭据（OAuth），无需 ADC 文件挂载，适合 Vercel
        ai = new GoogleGenAI({
            enterprise: true,
            project: projectId,
            location: location,
            googleAuthOptions: { credentials: JSON.parse(saJson) },
        });
    } else if (projectId) {
        // 主路径：API key + 项目 + 位置，SDK 3.x 会走 x-goog-api-key + 项目端点
        ai = new GoogleGenAI({
            apiKey: apiKey as string,
            enterprise: true,
            project: projectId,
            location: location,
        });
    } else {
        // 没配项目时退回纯 Gemini API（generativelanguage 端点，无区域概念）
        ai = new GoogleGenAI({ apiKey: apiKey as string });
    }

    // 过滤掉原有的 system 消息，便于我们自己控制
    let historyMessages = messages.filter(m => m.role !== 'system');

    // -------------------------------------------------------------
    // 1. 上下文链式压缩逻辑 (每 20 轮/40条 触发一次压缩)
    // -------------------------------------------------------------
    const MAX_HISTORY_LENGTH = 40; // 触发压缩的阈值 (20轮)
    const COMPRESS_COUNT = 20;     // 每次拿前多少条去压缩 (10轮)
    let summaryText = "";

    if (historyMessages.length > MAX_HISTORY_LENGTH) {
        const messagesToCompress = historyMessages.slice(0, COMPRESS_COUNT);
        // 保留剩下的消息（最新的）
        historyMessages = historyMessages.slice(COMPRESS_COUNT);

        // 拼接需要压缩的文本
        const textToCompress = messagesToCompress.map(m =>
            `${m.role === 'assistant' ? 'AI' : 'User'}: ${m.content}`
        ).join('\n');

        try {
            // 调用模型生成摘要 (使用较快且便宜的模型)
            const summaryResponse = await ai.models.generateContent({
                model: summaryModel,
                contents: [{
                    role: 'user',
                    parts: [{ text: `请将以下之前的对话记录压缩成一段精炼的摘要，保留核心需求、关键设定和未解决的问题，舍弃寒暄和无用信息。\n\n对话记录:\n${textToCompress}` }]
                }]
            });
            summaryText = summaryResponse.text || "";
            console.log("成功生成历史对话摘要");
        } catch (compressError) {
            console.error('压缩历史对话失败，回退至截断策略:', compressError);
            // 降级处理：如果压缩失败，就不带摘要，继续往下走
        }
    }

    const latestMessage = historyMessages.pop();

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', { status: 400 });
    }

    // -------------------------------------------------------------
    // 2. 组装请求 Contents
    // -------------------------------------------------------------
    const contents: any[] = [];

    // 如果生成了摘要，或者前端原本传了系统提示，在这里注入
    const originalSystemMsg = messages.find(m => m.role === 'system');
    let systemInstructionText = originalSystemMsg ? originalSystemMsg.content : "";
    if (summaryText) {
        systemInstructionText += `\n\n[之前的对话摘要]:\n${summaryText}`;
    }

    for (const msg of historyMessages) {
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    // 多模态文件与图片处理透传
    // gemini-4-hydrogen 额外支持 docx/pptx/xlsx/odt 等文档格式的 inlineData，
    // 前端只要是合法 MIME 就会按原样透传
    const latestParts: any[] = [];
    if (files.length) {
        for (const file of files) {
            const buffer = Buffer.from(await file.arrayBuffer());
            const mimeType = file.type || 'application/octet-stream';

            latestParts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: buffer.toString('base64')
                }
            });
        }
    }

    // 将最新输入的文字追加到文件数据之后
    latestParts.push({ text: latestMessage.content });

    contents.push({
        role: 'user',
        parts: latestParts
    });

    // -------------------------------------------------------------
    // 3. 发起主模型请求 (流式)
    // -------------------------------------------------------------
    try {
        const generateConfig: any = {
            tools: [{ googleSearch: {} }],
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ]
        };

        // gemini-4 系：只接受 thinkingLevel（LOW/MEDIUM/HIGH/XHIGH）。
        // 传 thinkingBudget 或 MINIMAL 会直接返回 400，所以这里不用 thinkingBudget。
        if (/^gemini-4/i.test(model)) {
            generateConfig.thinkingConfig = { thinkingLevel: thinkingLevel.toUpperCase() };
        }

        // 如果有 System Instruction (包含前端传的或我们刚刚生成的摘要)，则加入配置
        if (systemInstructionText.trim() !== "") {
            generateConfig.systemInstruction = {
                role: "system",
                parts: [{ text: systemInstructionText.trim() }]
            };
        }

        const responseStream = await ai.models.generateContentStream({
            model: model,
            contents: contents,
            config: generateConfig
        });

        const textEncoder = new TextEncoder();

        const readableStream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of responseStream) {
                        if (chunk.text) {
                            controller.enqueue(textEncoder.encode(chunk.text));
                        }
                    }
                } catch (e) {
                    console.error('Stream parsing error:', e);
                    controller.enqueue(textEncoder.encode('\n[解析流式数据出错]'));
                } finally {
                    controller.close();
                }
            }
        });

        return new Response(readableStream, { headers });

    } catch (error: any) {
        console.error('API call failed:', error);
        const msg = String(error?.message || error);
        let hint = '';

        if (/401|403|UNAUTHENTICATED|PERMISSION_DENIED|API key not valid/i.test(msg)) {
            hint = '\n\n提示：当前 G_API_KEY 无权访问带项目的 Agent Platform 端点（Express 类型 key 常见）。'
                + '请在 Google Cloud 控制台「API 和服务 → 凭据」创建**标准 Google Cloud API 密钥**（或改用服务账号），'
                + '然后直接把新 key 填到 Vercel 的 G_API_KEY（代码无需再改）。'
                + '若暂无法换 key，可配置环境变量 GCP_SA_JSON（整段服务账号 JSON）走 OAuth 兜底。';
        } else if (/404|NOT_FOUND|not found/i.test(msg)) {
            hint = `\n\n提示：模型 ${model} 在 ${location} 不可用。gemini-4-hydrogen 只支持 global / us / eu，`
                + '请确认 GCP_LOCATION 是 global，并确认项目已开通该模型访问权限。';
        } else if (/400/.test(msg) && /thinking/i.test(msg)) {
            hint = '\n\n提示：gemini-4 系不接受 thinkingBudget 或 thinkingLevel=MINIMAL，'
                + '只支持 LOW/MEDIUM/HIGH/XHIGH。';
        } else if (/429|RESOURCE_EXHAUSTED/i.test(msg)) {
            hint = '\n\n提示：配额或速率超限，请稍后重试或在控制台提升配额。';
        }

        return new Response('Agent Platform 请求失败: ' + msg + hint, { status: 500 });
    }
});
