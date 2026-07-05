import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class Memory {
  constructor(dir) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.characterState = {};
    this.timeline = [];
    this.chapterSummaries = [];
    this.foreshadows = [];
    this.load();
  }

  load() {
    try {
      this.characterState = JSON.parse(readFileSync(join(this.dir, 'characters.json'), 'utf-8'));
    } catch { this.characterState = {}; }
    try {
      this.timeline = JSON.parse(readFileSync(join(this.dir, 'timeline.json'), 'utf-8'));
    } catch { this.timeline = []; }
    try {
      this.chapterSummaries = JSON.parse(readFileSync(join(this.dir, 'summaries.json'), 'utf-8'));
    } catch { this.chapterSummaries = []; }
    try {
      this.foreshadows = JSON.parse(readFileSync(join(this.dir, 'foreshadows.json'), 'utf-8'));
    } catch { this.foreshadows = []; }
  }

  save() {
    writeFileSync(join(this.dir, 'characters.json'), JSON.stringify(this.characterState, null, 2));
    writeFileSync(join(this.dir, 'timeline.json'), JSON.stringify(this.timeline, null, 2));
    writeFileSync(join(this.dir, 'summaries.json'), JSON.stringify(this.chapterSummaries, null, 2));
    writeFileSync(join(this.dir, 'foreshadows.json'), JSON.stringify(this.foreshadows, null, 2));
  }

  // 清空所有记忆（每次新跑前调用）
  reset() {
    this.characterState = {};
    this.timeline = [];
    this.chapterSummaries = [];
    this.foreshadows = [];
    this.save();
  }

  // 初始化角色状态
  initCharacters(characters) {
    this.characterState = {};
    for (const [name, attrs] of Object.entries(characters)) {
      this.characterState[name] = {
        location: attrs.initialLocation || '',
        health: '健康',
        level: attrs.initialLevel || '',
        inventory: attrs.initialInventory || [],
        relationships: attrs.initialRelationships || {},
        status: '活跃',
        goals: attrs.initialGoals || [],  // 新增：当前目标
        last_seen_chapter: 0,  // 新增：最后出现章节
        ...attrs.extra,
      };
    }
    this.save();
  }

  // 更新角色状态（由 AI 解析后的结果更新）
  updateCharacters(changes) {
    for (const [name, attrs] of Object.entries(changes)) {
      if (this.characterState[name]) {
        const state = this.characterState[name];
        // 关系字段做合并而非覆盖，防止AI输出不全丢失数据
        if (attrs.relationships && typeof attrs.relationships === 'object') {
          state.relationships = { ...state.relationships, ...attrs.relationships };
          delete attrs.relationships;
        }
        Object.assign(state, attrs);
      }
    }
    // save 由调用方统一执行，这里不单独写盘
  }

  // 添加时间线事件
  addEvent(chapter, event) {
    this.timeline.push({ chapter, event, timestamp: Date.now() });
  }

  // 添加篇章摘要
  addSummary(chapter, summary) {
    this.chapterSummaries.push({ chapter, summary });
  }

  // 添加伏笔
  addForeshadow(foreshadow) {
    this.foreshadows.push(foreshadow);
  }

  // 获取前几章的摘要
  getRecentSummaries(n = 5) {
    return this.chapterSummaries.slice(-n);
  }

  // 构建写入 context 用的状态文本
  buildStateContext() {
    let text = '## 当前角色状态\n';
    for (const [name, state] of Object.entries(this.characterState)) {
      text += `- ${name}：位置=${state.location}，状态=${state.status}`;
      if (state.level) text += `，等级=${state.level}`;
      if (state.health && state.health !== '健康') text += `，健康=${state.health}`;
      if (state.inventory?.length) text += `，持有=[${state.inventory.slice(0, 10).join(', ')}]`;
      if (state.goals?.length) text += `，目标=[${state.goals.slice(0, 5).join(', ')}]`;
      if (state.relationships && Object.keys(state.relationships).length) {
        const rels = Object.entries(state.relationships)
          .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join('、') : v}`);
        text += `，关系=[${rels.join('; ')}]`;
      }
      if (state.last_seen_chapter) text += `，最后出现=第${state.last_seen_chapter}章`;
      text += '\n';
    }
    return text;
  }

  // 获取事件时间线文本
  buildTimelineContext() {
    if (this.timeline.length === 0) return '';
    let text = '## 已发生的重要事件\n';
    for (const t of this.timeline.slice(-8)) {
      text += `- 第${t.chapter}章：${t.event}\n`;
    }
    return text;
  }

  // 定期清理状态，防止无限膨胀
  cleanupState() {
    for (const [name, state] of Object.entries(this.characterState)) {
      if (state.inventory && state.inventory.length > 15) {
        state.inventory = state.inventory.slice(-15);
      }
      if (state.goals && state.goals.length > 8) {
        state.goals = state.goals.slice(-8);
      }
    }
    // 时间线总数超过 200 条时只保留最近 150 条
    if (this.timeline.length > 200) {
      this.timeline = this.timeline.slice(-150);
    }
    this.save();
  }
}
