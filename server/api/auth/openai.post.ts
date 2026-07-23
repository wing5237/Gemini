import {handleErr, openaiParser, streamResponse} from "~/utils/helper";
import {OpenAIBody, OpenAIReq} from "~/utils/types";

export default defineEventHandler(async (event) => {
    const body: OpenAIReq = await readBody(event);
    const {model, messages, key} = body;

    const openAIBody: OpenAIBody = {
        stream: true,
        model,
        messages,
    };

    // 去除 Cloudflare 依赖，默认请求 OpenRouter 接口
    const apiUrl = process.env.OPENAI_API_URL ?
        `${process.env.OPENAI_API_URL}/v1/chat/completions` :
        `https://openrouter.ai/api/v1/chat/completions`;

    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: key === undefined ? `Bearer ${process.env.OPENAI_API_KEY}` : `Bearer ${key}`,
            'Content-Type': 'application/json',
            // OpenRouter 推荐补充的标识请求头
            'HTTP-Referer': 'https://github.com/wing5237/AI-web',
            'X-Title': 'AI Web',
        },
        body: JSON.stringify(openAIBody),
    });

    if (!res.ok) {
        return handleErr(res);
    }

    return streamResponse(res, openaiParser);
});
