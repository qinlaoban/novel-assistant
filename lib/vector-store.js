import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getEmbedding, getEmbeddings } from './llm.js';

export class VectorStore {
  constructor(dir) {
    this.dir = dir;
    this.chunks = [];
    this.vectors = [];
    this.load();
  }

  load() {
    try {
      const c = JSON.parse(readFileSync(join(this.dir, 'chunks.json'), 'utf-8'));
      const v = JSON.parse(readFileSync(join(this.dir, 'vectors.json'), 'utf-8'));
      this.chunks = c;
      this.vectors = v;
    } catch {
      this.chunks = [];
      this.vectors = [];
    }
  }

  save() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'chunks.json'), JSON.stringify(this.chunks));
    writeFileSync(join(this.dir, 'vectors.json'), JSON.stringify(this.vectors));
  }

  // 添加一段文本到索引
  async add(text, meta = {}) {
    const vec = await getEmbedding(text, 'document');
    this.chunks.push({ text, meta });
    this.vectors.push(vec);
  }

  // 批量添加
  async addBatch(items) {
    const texts = items.map(i => i.text);
    const vecs = await getEmbeddings(texts, 'document');
    for (let i = 0; i < items.length; i++) {
      this.chunks.push({ text: items[i].text, meta: items[i].meta || {} });
      this.vectors.push(vecs[i]);
    }
  }

  // 余弦相似度
  cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // 搜索 top-k
  async search(query, k = 5) {
    if (this.vectors.length === 0) return [];
    const qvec = await getEmbedding(query, 'query');
    const scores = this.vectors.map((v, i) => ({ index: i, score: this.cosine(qvec, v) }));
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k).map(s => ({
      text: this.chunks[s.index].text,
      meta: this.chunks[s.index].meta,
      score: s.score,
    }));
  }

  // 多层检索：多个 query 分别搜索，去重合并
  async multiSearch(queries, kPerQuery = 3, topK = 8) {
    if (this.vectors.length === 0) return [];
    const qvecs = await getEmbeddings(queries, 'query');
    const seen = new Set();
    const all = [];
    for (let qi = 0; qi < queries.length; qi++) {
      const qvec = qvecs[qi];
      const scores = this.vectors.map((v, i) => ({ index: i, score: this.cosine(qvec, v) }));
      scores.sort((a, b) => b.score - a.score);
      for (const s of scores.slice(0, kPerQuery)) {
        const key = `${this.chunks[s.index].meta.chapter || 0}|${this.chunks[s.index].text.slice(0, 60)}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push({
            text: this.chunks[s.index].text,
            meta: this.chunks[s.index].meta,
            score: s.score,
          });
        }
      }
    }
    return all.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  get count() { return this.chunks.length; }
}
