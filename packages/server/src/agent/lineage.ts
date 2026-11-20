/**
 * 产物血缘与影响面分析。
 *
 * 为什么不放进 LangGraph state：state 用 threadId 隔离，每次修订都是新 run，
 * 进程内 MemorySaver 也留不住上一轮的状态。真正的血缘必须落在数据库里——
 * shots.characterIds 就是那个持久化字段，本文件负责建立和使用它。
 */

export interface LineageCharacter {
  id: number;
  name: string;
}

export interface LineageShot {
  id: number;
  characterIds: number[];
  imageUrl: string | null;
  videoUrl: string | null;
}

export interface ImpactAnalysis {
  /** 引用了变更角色、需要重新渲染的镜头 */
  affected: number[];
  /** 与变更无关、可以直接复用已有画面的镜头 */
  reused: number[];
}

/**
 * 从镜头文本中匹配出现的角色。
 * 除了全名，还匹配名字后两字（"林小雨"→"小雨"），覆盖剧本里常用的简称。
 */
export function matchCharacterIds(text: string, characters: LineageCharacter[]): number[] {
  const normalized = text.toLowerCase();
  if (!normalized) return [];

  return characters
    .filter((character) => {
      const name = character.name.trim();
      if (!name) return false;
      if (normalized.includes(name.toLowerCase())) return true;
      const shortName = name.length >= 3 ? name.slice(-2) : name;
      return shortName.length >= 2 && normalized.includes(shortName.toLowerCase());
    })
    .map((character) => character.id);
}

/** 根据角色 id 找出真正受影响的镜头，其余标记为可复用 */
export function analyzeCharacterImpact(shots: LineageShot[], changedCharacterIds: number[]): ImpactAnalysis {
  const changed = new Set(changedCharacterIds);
  const affected: number[] = [];
  const reused: number[] = [];

  for (const shot of shots) {
    if ((shot.characterIds || []).some((id) => changed.has(id))) affected.push(shot.id);
    else reused.push(shot.id);
  }

  return { affected, reused };
}

/** state.artifactLineage 的展示格式：character:12 → [shot:3, shot:7] */
export function buildArtifactLineage(shots: Array<{ id: number; characterIds: number[] }>): Record<string, string[]> {
  const lineage: Record<string, string[]> = {};
  for (const shot of shots) {
    for (const characterId of shot.characterIds || []) {
      const key = `character:${characterId}`;
      if (!lineage[key]) lineage[key] = [];
      lineage[key].push(`shot:${shot.id}`);
    }
  }
  return lineage;
}
