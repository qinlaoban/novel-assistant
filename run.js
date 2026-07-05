import { config } from './story-config.js';
import { Memory } from './lib/memory.js';
import { VectorStore } from './lib/vector-store.js';
import { Writer } from './lib/writer.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateDir = join(__dirname, 'state');
const vectorDir = join(__dirname, 'vector_index');
const chaptersDir = join(__dirname, 'chapters');

async function main() {
  console.log(`=== ${config.title} ===\n`);

  // 检查已有章节，找到最大编号
  let maxChapter = 0;
  if (existsSync(chaptersDir)) {
    const files = readdirSync(chaptersDir).filter(f => f.endsWith('.txt'));
    for (const f of files) {
      const match = f.match(/第(\d+)章/);
      if (match) {
        const num = parseInt(match[1]);
        if (num > maxChapter) maxChapter = num;
      }
    }
  }

  if (maxChapter > 0) {
    console.log(`已发现前 ${maxChapter} 章，从第 ${maxChapter + 1} 章继续写\n`);
  } else {
    console.log('首次运行，从第1章开始\n');
    // 清空旧状态前备份
    if (existsSync(stateDir) || existsSync(vectorDir)) {
      const { renameSync } = await import('fs');
      const now = Date.now();
      if (existsSync(stateDir)) renameSync(stateDir, `${stateDir}_bak_${now}`);
      if (existsSync(vectorDir)) renameSync(vectorDir, `${vectorDir}_bak_${now}`);
      console.log('已备份旧数据\n');
    }
  }

  // 初始化记忆系统
  const memory = new Memory(stateDir);
  if (maxChapter === 0) {
    memory.initCharacters(config.characters);
  }

  // 初始化向量库
  const vectorStore = new VectorStore(vectorDir);

  // 初始化写作者
  const writer = new Writer(memory, vectorStore, config);

  // 找到还没写的章节
  const chaptersToWrite = [];
  for (let i = 0; i < config.outline.length; i++) {
    const chapterNum = i + 1;
    if (chapterNum > maxChapter) {
      chaptersToWrite.push({ chapterNum, ...config.outline[i] });
    }
  }

  if (chaptersToWrite.length === 0) {
    console.log('所有章节已写完！');
    return;
  }

  console.log(`本次将写第 ${chaptersToWrite[0].chapterNum} ~ 第 ${chaptersToWrite[chaptersToWrite.length - 1].chapterNum} 章\n`);

  // 逐章生成
  for (const ch of chaptersToWrite) {
    try {
      await writer.writeChapter(ch.chapterNum, ch.title, ch.outline);
      console.log(`✓ 第${ch.chapterNum}章完成`);
    } catch (err) {
      console.error(`✗ 第${ch.chapterNum}章失败：`, err.message);
    }
  }

  // 打印最终状态
  console.log('\n=== 生成完成 ===');
  console.log(`总章节：${config.outline.length}`);
  console.log(`向量库片段数：${vectorStore.count}`);
}

main().catch(console.error);
