import { GoogleGenAI } from '@google/genai';
import { headers } from '~/utils/helper';
import { OpenAIMessage } from "~/utils/types";

export default defineEventHandler(async (event) => {
    // 1. 解析 GCP 服务账号密钥
    let credentials = {};
    try {
        credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY || '{}');
    } catch (e) {
        console.error("密钥解析失败，请检查 GCP_SERVICE_ACCOUNT_KEY 环境变量");
    }

    // 2. 初始化 Vertex AI 客户端
    const ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID,
        location: 'us-central1', // 推荐使用 us-central1 获取最全模型支持
        googleAuthOptions: {
            credentials,
        },
    });

    const body = await readFormData(event);
    const model = body.get('model') as string;
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'));
    const files = body.getAll('files') as File[];

    // 过滤掉系统提示词，保留真实对话
    const historyMessages = messages.filter(m => m.role !== 'system');
    const latestMessage = historyMessages.pop();

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', { status: 400 });
    }

    // 统一配置项：安全设置与工具
    const config = {
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
        tools: [{ googleSearch: {} }]
    };

    let responseStream;

    try {
        if (files.length) {
            // 带图片的处理逻辑
            const imageParts = await Promise.all(files.map(fileToGenerativePart));
            responseStream = await ai.models.generateContentStream({
                model,
                contents: [...imageParts, latestMessage.content],
                config
            });
        } else {
            // 标准多轮对话逻辑
            const chat = ai.chats.create({
                model,
                history: historyMessages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                })),
                config
            });
            responseStream = await chat.sendMessageStream({
                message: latestMessage.content
            });
        }
    } catch (error: any) {
        return new Response('API 调用失败: ' + error.message, { status: 500 });
    }

    // 处理流式输出
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
                console.error(e);
                controller.enqueue(textEncoder.encode('\n[已触发安全限制或获取内容失败，请重新开始对话]'));
            } finally {
                controller.close();
            }
        }
    });

    return new Response(readableStream, {
        headers,
    });
});

async function fileToGenerativePart(file: File) {
    return {
        inlineData: {
            data: Buffer.from(await file.arrayBuffer()).toString('base64'),
            mimeType: file.type,
        },
    };
}
