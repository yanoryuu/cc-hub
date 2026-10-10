// Firebase デプロイの手順(副作用なし。テスト対象)。
//   Hosting + preview(既定): 承認後 → hosting:channel:deploy でプレビューチャンネルへ → preview_ready で止まる
//                             → 「本番に反映」(promote)で、Hosting 以外の対象を deploy --only → hosting:clone <site>:<ch> <site>:live
//     ※ Hosting と他の対象(functions など)を同時に頼まれた場合、他の対象は promote のときにデプロイする
//       (プレビューの確認中に Functions やルールだけ先に本番へ出ないように。本番への反映をそろえる)
//       promote では先に他の対象を出し、失敗したら Hosting は本番に反映しない(プレビューは残る)
//   Hosting を preview なしで / Hosting 以外だけ: 承認後すぐ deploy --only <対象> で本番へ
// ビルド: 依頼に buildCommand があればそれを最初に実行する。firebase.json の hosting.predeploy は CLI 自身が実行するので重ねない
import type { FirebaseTarget } from '@cc-hub/shared';
import { cliOnly } from './config';

export type FbStep =
  | { kind: 'build'; command: string }
  | { kind: 'channel'; channel: string }
  | { kind: 'deploy'; targets: FirebaseTarget[] }
  | { kind: 'clone'; channel: string };

export interface FbPlan {
  /** 承認後(ユーザーの依頼なら直後)に実行する */
  first: FbStep[];
  /** first の後 preview_ready で止まるか */
  stopAtPreview: boolean;
  /** promote で実行する */
  onPromote: FbStep[];
}

export function planFirebase(o: { targets: FirebaseTarget[]; preview: boolean; channel: string; buildCommand: string | null }): FbPlan {
  const hosting = o.targets.includes('hosting');
  const others = o.targets.filter((t) => t !== 'hosting');
  const build: FbStep[] = o.buildCommand ? [{ kind: 'build', command: o.buildCommand }] : [];
  if (hosting && o.preview) {
    return {
      first: [...build, { kind: 'channel', channel: o.channel }],
      stopAtPreview: true,
      onPromote: [...(others.length ? [{ kind: 'deploy' as const, targets: others }] : []), { kind: 'clone', channel: o.channel }],
    };
  }
  return { first: [...build, { kind: 'deploy', targets: o.targets }], stopAtPreview: false, onPromote: [] };
}

/** 手順 → firebase CLI の引数 */
export function stepArgs(step: Exclude<FbStep, { kind: 'build' }>, projectId: string, site?: string): string[] {
  switch (step.kind) {
    case 'channel':
      return ['hosting:channel:deploy', step.channel, '--expires', '7d', '--json', '--project', projectId, '--non-interactive'];
    case 'deploy':
      return ['deploy', '--only', cliOnly(step.targets), '--json', '--project', projectId, '--non-interactive'];
    case 'clone':
      if (!site) throw new Error('サイト名がありません');
      return ['hosting:clone', `${site}:${step.channel}`, `${site}:live`, '--project', projectId, '--non-interactive'];
  }
}

/** 進捗の表示 */
export function stepLabel(step: FbStep): string {
  switch (step.kind) {
    case 'build':
      return 'ビルドしています';
    case 'channel':
      return `プレビューチャンネル ${step.channel} にデプロイしています`;
    case 'deploy':
      return `${cliOnly(step.targets)} を本番にデプロイしています`;
    case 'clone':
      return `プレビュー ${step.channel} を本番(live)に反映しています`;
  }
}
