import { chat, getEmbedding } from './llm.js';
import { writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export class Writer {
  constructor(memory, vectorStore, config) {
    this.memory = memory;
    this.vectorStore = vectorStore;
    this.config = config;
  }

  // 组装写一章的 prompt
  buildPrompt(chapterNum, chapterTitle, chapterOutline) {
    const worldText = `## 世界观设定\n${this.config.worldSetting}\n`;
    const stateText = this.memory.buildStateContext();
    const timelineText = this.memory.buildTimelineContext();

    const totalSummaries = this.memory.chapterSummaries.length;
    const summaryCount = Math.min(10, Math.max(5, totalSummaries));
    const summaries = this.memory.getRecentSummaries(summaryCount);
    let summaryText = '';
    if (summaries.length > 0) {
      summaryText = '## 前文回顾\n';
      for (const s of summaries) {
        summaryText += `第${s.chapter}章：${s.summary}\n`;
      }
    }

    const styleText = this.config.styleGuide
      ? `## 文风要求\n${this.config.styleGuide}\n`
      : '';

    const outlineText = `## 本章大纲\n${chapterOutline}\n`;

    // 关键：强制章节编号和标题
    const instruction = `## 写作要求
- 请写一章 ${this.config.genre || '小说'} 正文
- 每章约 ${this.config.chapterLength || 2000} 字
- 保持角色性格一致
- 对话符合角色身份
- 遵循世界观设定
- 用中文写作

## 反AI文格式要求（必须遵守）
- 段落控制在2-4行，适配手机阅读
- 对话每段不超过3句
- 开头100字不要写环境/天气/起床，直接从对话/动作/冲突开始
- 一句话能解决的不要写成一段话
- 不用"说道/问道"，用动作替代（例：铁牛推开门。"吃了吗？"——不用"铁牛问道"）

## 禁止句式
- 禁止使用 "不是……而是……" 句式描述角色情绪或事件解释。错误示例："他不是生气，而是失望"。正确写法：直接写结果"他失望了"。
- 禁止连用两个以上破折号。错误示例："你——你这是——"。需要中断用句号，需要强调用动作替代。
- 禁止写"他不知道的是"、"这一去"等章末套话钩子。

## 严格格式要求
- 第一行必须是：第${chapterNum}章 ${chapterTitle}
- 然后空一行开始正文
- 不要在正文中再出现章节编号

输出完整的章节正文：`;

    return `${worldText}\n${stateText}\n${timelineText}\n${summaryText}\n${styleText}\n${outlineText}\n${instruction}`;
  }

  // 写一章
  async writeChapter(chapterNum, chapterTitle, chapterOutline) {
    console.log(`\n=== 写第${chapterNum}章：${chapterTitle} ===`);

    // 写前备份，支持回滚
    const stateDir = join(process.cwd(), 'state');
    const bakFile = join(stateDir, 'characters.bak.json');
    if (existsSync(join(stateDir, 'characters.json'))) {
      copyFileSync(join(stateDir, 'characters.json'), bakFile);
    }

    const prompt = this.buildPrompt(chapterNum, chapterTitle, chapterOutline);

    // 多层检索：大纲 + 活跃角色
    let searchResults = [];
    if (this.vectorStore.count > 0) {
      const queries = [chapterOutline];
      const activeChars = Object.entries(this.memory.characterState)
        .filter(([, s]) => s.status === '活跃')
        .map(([name]) => name);
      if (activeChars.length > 0) {
        queries.push(`${activeChars.join('、')} 的相关情节`);
      }
      searchResults = await this.vectorStore.multiSearch(queries, 3, 6);
    }

    const messages = [
      { role: 'system', content: '你是一个专业的小说作家。根据提供的设定和前文，写出一章连贯、一致的小说正文。严格遵守格式要求。' },
    ];

    if (searchResults.length > 0) {
      messages.push({
        role: 'system',
        content: `## 与本章相关的前文片段，请确保不与之矛盾：\n${searchResults.map(r => r.text).join('\n---\n')}`,
      });
    }

    messages.push({ role: 'user', content: prompt });

    let chapterText = await chat(messages, {
      temperature: 0.7,
      maxTokens: 4096,
    });

    // 后处理：修正章节编号和标题
    chapterText = this.fixChapterHeader(chapterText, chapterNum, chapterTitle);

    // 保存到文件
    await this.saveChapter(chapterNum, chapterTitle, chapterText);

    // 更新记忆
    await this.afterWrite(chapterNum, chapterTitle, chapterText);

    return chapterText;
  }

  // 修正章节标题（强制用正确的编号和标题）
  fixChapterHeader(text, chapterNum, chapterTitle) {
    const correctHeader = `第${chapterNum}章 ${chapterTitle}`;
    // 去掉开头可能的 # 或空行
    let cleaned = text.replace(/^[\s#]+/, '').trim();
    // 替换第一行为正确的章节标题
    const lines = cleaned.split('\n');
    if (lines.length > 0) {
      lines[0] = correctHeader;
    }
    return lines.join('\n');
  }

  // 写后更新记忆
  async afterWrite(chapterNum, chapterTitle, chapterText) {
    // 改进：CoT提取 + 差异检测
    const analysisPrompt = `请分析这章小说的变化。

【当前角色状态（上一章结束时）】
${JSON.stringify(this.memory.characterState, null, 2)}

【本章正文】
${chapterText}

【任务】
1. 先用一段文字分析：本章中哪些角色的哪些属性发生了变化？如果没有变化，明确说"无变化"。
2. 然后输出 JSON 格式的变化（只输出变化的部分，没变化的不要输出）：

{
  "summary": "本章摘要（100-200字）",
  "events": ["事件1", "事件2", ...],
      "foreshadows": [
    {"description": "本章埋下或暗示的未来关键伏笔", "characters": ["涉及角色"]}
  ],
  "characterChanges": {
    "角色名": {
      "location": "新位置（如果有变化）",
      "health": "健康/受伤/...（如果有变化）",
      "level": "新等级（如果有变化）",
      "inventory": "如果有变化，必须列出完整清单（所有物品），格式为数组，新增物品直接追加，不再持有的物品不要列出",
      "status": "如果有变化，只能从以下值选择：活跃/受伤/昏迷/死亡/离开/闭关",
      "goals": "如果有变化，必须列出当前所有目标的完整清单（数组），完成的目标不列出，新目标追加进去",
      "relationships": "如果有变化，列出完整关系对象。**注意：关系值必须为数组格式**，如 {'师徒': ['林青云', '苏小月']}，不要写成 {'师徒': '苏小月'}",
      "last_seen_chapter": ${chapterNum}
    }
  }
}

注意：
- 只输出变化的字段，没变化的不要重复
- 如果某个角色完全没有变化，不要出现在 characterChanges 中
- inventory 和 goals 如果变化，必须输出完整清单，不是增量
- last_seen_chapter 必须更新为当前章节号
- foreshadows 必须输出（没有就输出空数组 []），不允许省略`;

    try {
      const result = await chat([
        { role: 'system', content: '你是一个小说分析助手。根据章节内容，提取结构化信息。先推理再输出JSON。' },
        { role: 'user', content: analysisPrompt },
      ], { temperature: 0.3, maxTokens: 2000 });

      // 提取 JSON（可能包含 CoT 文本）
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('未找到JSON');
      
      const data = JSON.parse(jsonMatch[0].replace(/```json|```/g, '').trim());
      
      // 校验分析结果
      this.validateAnalysis(data, chapterNum);
      
      // 更新摘要
      this.memory.addSummary(chapterNum, data.summary || chapterTitle);
      
      // 更新事件
      for (const event of (data.events || [])) {
        this.memory.addEvent(chapterNum, event);
      }
      
      // 更新伏笔
      for (const fs of (data.foreshadows || [])) {
        this.memory.addForeshadow({ chapter: chapterNum, ...fs });
      }
      
      // 更新角色状态（只更新变化的部分）
      if (data.characterChanges) {
        this.memory.updateCharacters(data.characterChanges);
      }
    } catch (e) {
      console.log(`  ⚠ 分析失败: ${e.message}`);
      this.memory.addSummary(chapterNum, chapterTitle);
    }

    // 原文存入向量库
    const chunks = this.chunkText(chapterText, chapterNum, chapterTitle);
    if (chunks.length > 0) {
      await this.vectorStore.addBatch(chunks);
      this.vectorStore.save();
    }
    this.memory.save();

    // 本章正文逻辑检测 + AI味静态检测
    await this.logicCheck(chapterNum, chapterText);
    this.aiFlavorCheck(chapterText, chapterNum);

    // 每 5 章做一次交叉校验，每 10 章做一次截断清理
    if (chapterNum > 0 && chapterNum % 5 === 0) {
      await this.stateAudit(chapterNum);
    }
    if (chapterNum % 10 === 0) {
      this.memory.cleanupState();
    }
  }

  // 校验 AI 分析结果，防止明显错误
  validateAnalysis(data, chapterNum) {
    const warnings = [];
    const validStatuses = ['活跃', '受伤', '昏迷', '死亡', '离开', '闭关'];

    if (data.characterChanges) {
      for (const name of Object.keys(data.characterChanges)) {
        if (!this.memory.characterState[name]) {
          warnings.push(`未知角色: ${name}`);
          continue;
        }
        const ch = data.characterChanges[name];

        // inventory 必须为数组
        if (ch.inventory !== undefined && !Array.isArray(ch.inventory)) {
          warnings.push(`${name} 的 inventory 不是数组，已忽略`);
          delete ch.inventory;
        }
        // goals 必须为数组
        if (ch.goals !== undefined && !Array.isArray(ch.goals)) {
          warnings.push(`${name} 的 goals 不是数组，已忽略`);
          delete ch.goals;
        }
        // 关系值必须为数组
        if (ch.relationships) {
          for (const [relType, relVal] of Object.entries(ch.relationships)) {
            if (typeof relVal === 'string') {
              warnings.push(`${name} 的关系 "${relType}" 是字符串"${relVal}"，应为数组，已修正`);
              ch.relationships[relType] = [relVal];
            }
          }
        }
        // status 必须在合法值范围内
        if (ch.status && !validStatuses.includes(ch.status)) {
          warnings.push(`${name} 的状态"${ch.status}"不是标准值，已忽略`);
          delete ch.status;
        }
      }
    }

    if (!data.summary || data.summary.length < 10) {
      warnings.push('摘要过短');
    }

    if (data.foreshadows && !Array.isArray(data.foreshadows)) {
      warnings.push('伏笔格式异常，已忽略');
      data.foreshadows = [];
    }

    if (warnings.length > 0) {
      console.log(`  ⚠ 第${chapterNum}章分析校验: ${warnings.join('; ')}`);
    }
    return warnings.length === 0;
  }

  // 章节正文逻辑检测
  async logicCheck(chapterNum, chapterText) {
    const checkPrompt = `请检测以下章节正文中是否存在逻辑矛盾。

【本章正文】
${chapterText}

【检测项】
1. 角色在同场景中位置是否矛盾？（如 A 说在某地，同一场景又在别处出现）
2. 角色对话中是否引用了尚未发生的事件？
3. 是否出现前文已毁/已丢失的物品？
4. 角色姓名是否写错（临时编了个名字）？

只检查上述四项明显的硬逻辑 bug。如果没有问题，输出 OK。如果有问题，输出具体的矛盾描述。`;

    try {
      const result = await chat([
        { role: 'system', content: '你检查小说正文中的硬逻辑矛盾，只报明显错误，不挑剔风格问题。' },
        { role: 'user', content: checkPrompt },
      ], { temperature: 0.1, maxTokens: 500 });

      if (result.includes('OK') || result.includes('没问题')) {
        return;
      }
      console.log(`  ⚠ 第${chapterNum}章逻辑问题: ${result.slice(0, 200)}`);
    } catch {
      // 静默失败，不阻塞流程
    }
  }

  // AI味静态检测（无API调用，正则扫描）
  aiFlavorCheck(chapterText, chapterNum) {
    const checks = [
      { pattern: /心中[一惊一凛一沉]/g, label: '情绪套话"心中…"', limit: 2 },
      { pattern: /眼中闪过一丝/g, label: '"眼中闪过一丝…"', limit: 1 },
      { pattern: /不由得/g, label: '"不由得…"', limit: 2 },
      { pattern: /说道|问道/g, label: '"说道/问道"', limit: 8 },
      { pattern: /不是.{1,20}而是/g, label: '"不是A而是B"', limit: 0 },
      { pattern: /——/g, label: '破折号', limit: 3 },
      { pattern: /他.{0,3}不知道的是/g, label: '钩子套话"他不知道的是"', limit: 0 },
    ];

    const warnings = [];
    for (const { pattern, label, limit } of checks) {
      const matches = chapterText.match(pattern);
      const count = matches ? matches.length : 0;
      if (count > limit) {
        warnings.push(`${label} ${count}次(上限${limit})`);
      }
    }
    if (warnings.length > 0) {
      console.log(`  ⚠ 第${chapterNum}章AI味检测: ${warnings.join('; ')}`);
    }
  }

  // 每N章交叉校验：用摘要/时间线复核角色状态，修正矛盾
  async stateAudit(chapterNum) {
    console.log(`  🔍 第${chapterNum}章一致性审计...`);
    const allState = this.memory.characterState;
    const summaries = this.memory.getRecentSummaries(8);
    const timeline = this.memory.timeline.slice(-40);

    const auditPrompt = `你是小说编辑，请根据以下信息审计角色状态一致性。发现问题请修正，没问题就输出空对象。

【最近章节摘要】
${summaries.map(s => `第${s.chapter}章: ${s.summary}`).join('\n')}

【最近事件时间线】
${timeline.map(e => `第${e.chapter}章: ${e.event}`).join('\n')}

【当前角色状态】
${JSON.stringify(allState, null, 2)}

逐项严格检查：
1. 物品归属：某角色持有的物品是否与摘要矛盾？如物品被某人获取了但仍在别人手中
2. 等级/能力：角色的等级是否与摘要描述匹配？
3. 已完成目标：重点检查 goals 中是否有明确在摘要/时间线中已完成的条目。例如"通过考核"在第一章已完成，"找回灵芝"在第四章已完成。**必须删除这些过期目标**
4. 双向关系：A的{关系:B} → B的{关系:A}是否存在且一致？例如陈长老的"徒弟"是林青云和苏小月，那么林青云和苏小月的关系中应包含对应的"师父"或"师叔"条目。**缺失的必须补充**
5. 异常状态：是否有明显不合理的字段（死去的角色标记为活跃等）
6. 关系值格式：所有关系值必须为数组格式 {"徒弟": ["林青云", "苏小月"]}，不允许是字符串。如果发现字符串格式，必须修正为数组

输出JSON（只输出需要修正的字段，没问题就输出空对象）：
{
  "陈长老": { "relationships": {"徒弟": ["林青云", "苏小月"]}, "goals": ["目标1", "目标2"] },
  "林青云": { "goals": ["目标1", "目标2"] }
}

注意：只修正明确矛盾，不猜测添加新信息。inventory/goals/relationships 修正时必须输出完整清单`;

    try {
      const result = await chat([
        { role: 'system', content: '你是小说编辑，只修正明确矛盾。' },
        { role: 'user', content: auditPrompt },
      ], { temperature: 0.1, maxTokens: 2000 });

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.log('  ✓ 审计通过，无修正'); return; }

      const corrections = JSON.parse(jsonMatch[0].replace(/```json|```/g, '').trim());
      const names = Object.keys(corrections);
      if (names.length === 0) { console.log('  ✓ 审计通过，无修正'); return; }

      for (const [name, attrs] of Object.entries(corrections)) {
        if (!this.memory.characterState[name]) continue;
        Object.assign(this.memory.characterState[name], attrs);
      }
      this.memory.save();
      console.log(`  ✓ 审计完成，修正了 ${names.join('、')}`);
    } catch (e) {
      console.log(`  ⚠ 审计失败: ${e.message}`);
    }
  }

  // 文本分块（600字/块，适合小说场景）
  chunkText(text, chapterNum, title) {
    const chunks = [];
    const paragraphs = text.split('\n').filter(p => p.trim().length > 0);
    let current = '';
    for (const p of paragraphs) {
      if (current.length + p.length > 600 && current.length > 0) {
        chunks.push({ text: current, meta: { chapter: chapterNum, title } });
        current = '';
      }
      current += p + '\n';
    }
    if (current.trim()) {
      chunks.push({ text: current, meta: { chapter: chapterNum, title } });
    }
    return chunks;
  }

  async saveChapter(chapterNum, title, text) {
    const dir = join(process.cwd(), 'chapters');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `第${String(chapterNum).padStart(2, '0')}章_${title}.txt`;
    writeFileSync(join(dir, filename), text, 'utf-8');
    console.log(`  📝 已保存: ${filename}`);
  }
}
