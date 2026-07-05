import axios from 'axios';
import 'dotenv/config';

const DASHSCOPE_API = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';

export async function getEmbedding(text, type = 'document') {
  const resp = await axios.post(DASHSCOPE_API, {
    model: 'text-embedding-v3',
    input: { texts: [text] },
    parameters: { text_type: type },
  }, {
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return resp.data.output.embeddings[0].embedding;
}

export async function getEmbeddings(texts, type = 'document') {
  const results = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    const resp = await axios.post(DASHSCOPE_API, {
      model: 'text-embedding-v3',
      input: { texts: batch },
      parameters: { text_type: type },
    }, {
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    results.push(...resp.data.output.embeddings.map(e => e.embedding));
    if (i + 10 < texts.length) await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

export async function chat(messages, options = {}) {
  const resp = await axios.post(DEEPSEEK_API, {
    model: options.model || 'deepseek-chat',
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4096,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return resp.data.choices[0].message.content;
}
