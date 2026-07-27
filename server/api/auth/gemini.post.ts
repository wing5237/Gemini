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

    // 1. 上下文滑动窗口压缩：过滤 system 后，只保留最近的 40 条记录（即 20 轮对话）
    const historyMessages = messages.filter(m => m.role !== 'system').slice(-40);
    const latestMessage = historyMessages.pop();

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', { status: 400 });
    }

    const contents: any[] = [];
    for (const msg of historyMessages) {
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    // 2. 多模态文件与图片处理透传
    const latestParts: any[] = [];
    if (files.length) {
        for (const file of files) {
            const buffer = Buffer.from(await file.arrayBuffer());
            // 提取准确的 MIME 类型，确保大模型能正确识别是 PDF 还是图像
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

    // 3. 初始化最新 SDK，兼容 Cloudflare 代理
    const ai = new GoogleGenAI({
        apiKey: apiKey,
        // 若使用你的 Cloudflare Worker 代理域名，取消下方注释：
        // baseUrl: 'https://api.wingjj.dpdns.org',
        vertexai: projectId ? {
            project: projectId,
            location: location
        } : undefined
    });

    try {
        // 使用 SDK 的流式调用
        const responseStream = await ai.models.generateContentStream({
            model: model,
            contents: contents,
            config: {
                tools: [{ googleSearch: {} }],
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                ]
            }
        });

        const textEncoder = new TextEncoder();
        
        // 封装为前端需要的 ReadableStream
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
