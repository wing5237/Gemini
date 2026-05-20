import {GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, SafetySetting} from '@google/generative-ai'
import {headers} from '~/utils/helper';
import {OpenAIMessage} from "~/utils/types";

const genAI = new GoogleGenerativeAI(process.env.G_API_KEY!)

export default defineEventHandler(async (event) => {
    const body = await readFormData(event)
    const model = body.get('model') as string
    const messages: OpenAIMessage[] = JSON.parse(<string>body.get('messages'))
    const files = body.getAll('files') as File[]

    // 1. 初始化模型并强行注入官方联网搜索
    const m = genAI.getGenerativeModel({
        model, 
        safetySettings,
        tools: [{ googleSearch: {} }] 
    })

    // 2. 修复上下文裁剪 Bug：不再盲目 slice(1)，而是过滤掉系统提示词，保留所有真实对话
    // 同时过滤掉最后一项（最新消息），因为最新消息要通过 sendMessageStream 发送
    const historyMessages = messages.filter(m => m.role !== 'system');
    const latestMessage = historyMessages.pop(); // 弹出最后一项作为当前提问

    if (!latestMessage) {
        return new Response('明细数据为空，请重新开始对话', {status: 400})
    }

    let res
    if (files.length) {
        // 带图片的处理逻辑
        const imageParts = await Promise.all(files.map(fileToGenerativePart))
        res = await m.generateContentStream([latestMessage.content, ...imageParts])
    } else {
        // 3. 完美的标准多轮对话上下文映射
        const chat = m.startChat({
            history: historyMessages.map(m => ({
                // Gemini 的角色只认 'user' 和 'model'，这里做精准转换
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
        })
        // 发送最新的一条消息
        res = await chat.sendMessageStream(latestMessage.content)
    }

    const textEncoder = new TextEncoder()
    const readableStream = new ReadableStream({
        async start(controller) {
            for await (const chunk of res.stream) {
                try {
                    controller.enqueue(textEncoder.encode(chunk.text()))
                } catch (e) {
                    console.error(e)
                    controller.enqueue(textEncoder.encode('已触发安全限制或获取内容失败，请重新开始对话'))
                }
            }
            controller.close()
        }
    })

    return new Response(readableStream, {
        headers,
    })
})

async function fileToGenerativePart(file: File) {
    return {
        inlineData: {
            data: Buffer.from(await file.arrayBuffer()).toString('base64'),
            mimeType: file.type,
        },
    };
}

const safetySettings: SafetySetting[] = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
]
