import { GoogleGenAI } from '@google/genai';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { headers } from '~/utils/helper';
import { OpenAIMessage } from "~/utils/types";
import fs from 'fs';

export default defineEventHandler(async (event) => {
    // 将 Vercel 环境变量中的 GCP 密钥写入临时文件供 Anthropic SDK 使用
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_SERVICE_ACCOUNT_KEY) {
        const keyPath = '/tmp/gcp-key.json';
        fs.writeFileSync(keyPath, process.env.GCP_SERVICE_ACCOUNT_KEY);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    }

    const body = await readFormData(event);
    const model = body.get('model') as string;
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'));
    const files = body.getAll('files') as File[];

    const historyMessages = messages.filter(m => m.role !== 'system');
    const latestMessage = historyMessages.pop();

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', { status: 400 });
    }

    const textEncoder = new TextEncoder();
    const projectId = process.env.GCP_PROJECT_ID || 'gen-lang-client-0570098364';

    // 1. Claude 模型处理分支
    if (model && model.includes('claude')) {
        const client = new AnthropicVertex({
            region: 'us-central1',
            projectId: projectId,
        });

        const claudeMessages = historyMessages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
        }));

        let currentContent: any[] = [{ type: 'text', text: latestMessage.content }];
        if (files.length) {
            const imageParts = await Promise.all(files.map(async (file) => ({
                type: "image",
                source: {
                    type: "base64",
                    media_type: file.type,
                    data: Buffer.from(await file.arrayBuffer()).toString('base64'),
                }
            })));
            currentContent = [...imageParts, ...currentContent];
        }
        claudeMessages.push({ role: 'user', content: currentContent as any });

        try {
            const stream = await client.messages.create({
                model: model,
                max_tokens: 4096,
                messages: claudeMessages as any,
                stream: true,
            });

            const readableStream = new ReadableStream({
                async start(controller) {
                    try {
                        for await (const chunk of stream) {
                            if (chunk.type === 'content_block_delta' && chunk.delta.text) {
                                controller.enqueue(textEncoder.encode(chunk.delta.text));
                            }
                        }
                    } catch (e: any) {
                        controller.enqueue(textEncoder.encode(`\n[Claude 调用失败: ${e.message}]`));
                    } finally {
                        controller.close();
                    }
                }
            });
            return new Response(readableStream, { headers });
        } catch (error: any) {
            return new Response('Claude API 拒绝请求: ' + error.message, { status: 500 });
        }
    }

    // 2. Gemini 模型处理分支 (Vertex AI 模式)
    let credentials = {};
    try {
        credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY || '{}');
    } catch (e) {}

    const ai = new GoogleGenAI({
        vertexai: true,
        project: projectId,
        location: 'us-central1',
        googleAuthOptions: { credentials },
    });

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
            const imageParts = await Promise.all(files.map(async (file) => ({
                inlineData: {
                    data: Buffer.from(await file.arrayBuffer()).toString('base64'),
                    mimeType: file.type,
                }
            })));
            responseStream = await ai.models.generateContentStream({
                model,
                contents: [...imageParts, latestMessage.content],
                config
            });
        } else {
            const chat = ai.chats.create({
                model,
                history: historyMessages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                })),
                config
            });
            responseStream = await chat.sendMessageStream({ message: latestMessage.content });
        }
    } catch (error: any) {
        return new Response('Gemini API 调用失败: ' + error.message, { status: 500 });
    }

    const readableStream = new ReadableStream({
        async start(controller) {
            try {
                for await (const chunk of responseStream) {
                    if (chunk.text) {
                        controller.enqueue(textEncoder.encode(chunk.text));
                    }
                }
            } catch (e) {
                controller.enqueue(textEncoder.encode('\n[Gemini 触发安全限制或获取内容失败]'));
            } finally {
                controller.close();
            }
        }
    });

    return new Response(readableStream, { headers });
});
