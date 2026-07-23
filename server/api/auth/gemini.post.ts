import { headers } from '~/utils/helper';
import { OpenAIMessage } from "~/utils/types";

export default defineEventHandler(async (event) => {
    const apiKey = process.env.G_API_KEY;
    const projectId = process.env.GCP_PROJECT_ID; // 你的 GCP 项目 ID

    if (!apiKey) {
        return new Response('未配置 G_API_KEY 环境变量', { status: 500 });
    }
    if (!projectId) {
        return new Response('未配置 GCP_PROJECT_ID 环境变量', { status: 500 });
    }

    const body = await readFormData(event);
    const model = (body.get('model') as string) || 'gemini-2.5-flash';
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'));
    const files = body.getAll('files') as File[];

    const historyMessages = messages.filter(m => m.role !== 'system');
    const latestMessage = historyMessages.pop();

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', { status: 400 });
    }

    // 1. 构建 Vertex AI / Agent Platform 的专属请求地址 (URL)
    const location = 'us-central1';
    const endpointUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    // 2. 组装符合 Vertex AI 规范的 contents 结构
    const contents: any[] = [];

    // 映射多轮对话历史
    for (const msg of historyMessages) {
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    // 处理当前最新消息及图片附件
    const latestParts: any[] = [];
    if (files.length) {
        for (const file of files) {
            const buffer = Buffer.from(await file.arrayBuffer());
            latestParts.push({
                inlineData: {
                    mimeType: file.type,
                    data: buffer.toString('base64')
                }
            });
        }
    }
    latestParts.push({ text: latestMessage.content });

    contents.push({
        role: 'user',
        parts: latestParts
    });

    // 3. 组装请求 Payload
    const payload = {
        contents,
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
        tools: [{ googleSearch: {} }]
    };

    // 4. 发起原生 Fetch 请求
    let upstreamResponse;
    try {
        upstreamResponse = await globalThis.fetch(endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
    } catch (error: any) {
        return new Response('连接 Agent Platform 失败: ' + error.message, { status: 500 });
    }

    if (!upstreamResponse.ok || !upstreamResponse.body) {
        const errText = await upstreamResponse.text();
        return new Response(`Agent Platform 拒绝请求 (${upstreamResponse.status}): ${errText}`, { status: 500 });
    }

    // 5. 解析并转发 SSE 流式响应给前端
    const textEncoder = new TextEncoder();
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    const readableStream = new ReadableStream({
        async start(controller) {
            try {
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            const jsonStr = trimmed.replace('data:', '').trim();
                            if (jsonStr) {
                                const data = JSON.parse(jsonStr);
                                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                                if (text) {
                                    controller.enqueue(textEncoder.encode(text));
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(e);
                controller.enqueue(textEncoder.encode('\n[解析流式数据出错]'));
            } finally {
                controller.close();
            }
        }
    });

    return new Response(readableStream, { headers });
});
