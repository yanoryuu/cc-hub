// スキル一覧(ユーザー / プロジェクト / プラグイン)。クリックで選択中のセッションの入力欄に「/<name> 」を入れる
import { useMemo, useState } from 'react';
import type { SkillInfo, SkillSource } from '@cc-hub/shared';
import { insertIntoComposer } from '../composer';
import { SOURCE_LABEL, useSkills } from '../ext';
import { useHub } from '../store';
import { projectLabel } from '../util';

const ORDER: SkillSource[] = ['project', 'user', 'plugin'];

/** スキルを選んだとき: 選択中のセッションの入力欄に入れて、そのセッションを開く。入れられなければ理由を返す */
export function useInsertSkill(): (s: SkillInfo) => string | null {
  return (skill) => {
    const st = useHub.getState();
    const s = st.selectedId ? st.sessions[st.selectedId] : undefined;
    if (!s) return 'セッションを選ぶと、その入力欄に入れられます';
    if (s.managed && s.status === 'stopped') return `「${s.name}」は停止中です。再起動してから使ってください`;
    insertIntoComposer(s.id, `/${skill.name} `);
    st.open(s.id);
    return null;
  };
}

export function SkillsView({ cwd, compact = false }: { cwd: string | null; compact?: boolean }) {
  const { data, loading, error, reload } = useSkills(cwd);
  const [q, setQ] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const insert = useInsertSkill();
  const target = useHub((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined));

  const groups = useMemo(() => {
    const k = q.trim().toLowerCase();
    const list = (data ?? []).filter(
      (s) => !k || s.name.toLowerCase().includes(k) || s.description.toLowerCase().includes(k) || (s.plugin ?? '').toLowerCase().includes(k),
    );
    return ORDER.map((src) => ({ src, items: list.filter((s) => s.source === src) })).filter((g) => g.items.length > 0);
  }, [data, q]);
  const total = data?.length ?? 0;
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className={`ext-view ${compact ? 'compact' : ''}`}>
      <div className="ext-head">
        {!compact && <h2 className="ext-title">スキル</h2>}
        <span className="ext-scope" title={cwd ?? 'ユーザーのホーム'}>
          対象: <b>{cwd ? projectLabel(cwd) : 'ホーム(ユーザー設定のみ)'}</b>
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={reload} disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : null} 再読み込み
        </button>
      </div>
      <div className="ext-search">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`スキルを検索(${total} 件)`}
          aria-label="スキルを検索"
        />
      </div>
      <p className="ext-lead">
        {target
          ? `クリックすると「${target.name}」の入力欄に /名前 を入れます。`
          : 'セッションを選ぶと、クリックでその入力欄に /名前 を入れられます。'}
      </p>
      {note && (
        <div className="ext-note" role="status">
          {note}
        </div>
      )}
      {error && <div className="form-error pad">{error}</div>}
      {!data && loading && <div className="empty small">読み込み中…</div>}
      {data && shown === 0 && <div className="empty small">{q ? '一致するスキルはありません' : 'スキルが見つかりません'}</div>}
      {groups.map((g) => (
        <section key={g.src} className="skill-group" aria-label={SOURCE_LABEL[g.src]}>
          <h3 className="skill-group-title">
            <span className={`src-badge src-${g.src}`}>{SOURCE_LABEL[g.src]}</span>
            <span className="count">{g.items.length}</span>
          </h3>
          <ul className="skill-list">
            {g.items.map((s) => (
              <li key={s.name}>
                <button
                  className="skill-item"
                  title={s.path}
                  onClick={() => {
                    const why = insert(s);
                    setNote(why);
                  }}
                >
                  <span className="skill-top">
                    <span className="skill-name">/{s.name}</span>
                    {s.plugin && <span className="tag">{s.plugin}</span>}
                    {s.kind === 'command' && <span className="kind-note">コマンド</span>}
                  </span>
                  {s.description && <span className="skill-desc">{s.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
