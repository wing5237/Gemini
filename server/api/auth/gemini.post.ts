import { headers } from '~/utils/helper';
import { OpenAIMessage } from "~/utils/types";
import { GoogleGenAI } from '@google/genai';

export default defineEventHandler(async (event) => {
    const apiKey = process.env.G_API_KEY;
    const projectId = process.env.GCP_PROJECT_ID;
    const location = 'us-central1';

    if (!apiKey) {
        return new Response('未配置 G_API_KEY 环境变量', { status: 500 });
    }

    const body = await readFormData(event);
    const model = (body.get('model') as string) || 'gemini-3.6-flash';
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'));
    const files = body.getAll('files') as File[];

    const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: projectId ? {
            project: projectId,
            location: location
        } : undefined
    });

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
                model: 'gemini-3.6-flash',
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
        return new Response('Agent Platform 请求失败: ' + error.message, { status: 500 });
    }
});
