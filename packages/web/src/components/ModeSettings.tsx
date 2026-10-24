// 設定 → モード: 新規セッションのモードの追加・編集・並べ替え
import { useEffect, useState } from 'react';
import { BUILTIN_MODE_IDS, MODE_PERMISSIONS, SESSION_MODELS, type ModePermission, type ModePreset } from '@cc-hub/shared';
import { errText } from '../api';
import { modeApi, useModes } from '../modes';
import { ConfirmModal } from './RepoCommon';

const PERMISSION_LABEL: Record<ModePermission, string> = {
  default: '毎回確認する(default)',
  acceptEdits: '編集は確認しない(acceptEdits)',
  auto: '自動(auto)',
  plan: '計画モード(plan)',
};

const sameList = (a: ModePreset[], b: ModePreset[]) => JSON.stringify(a) === JSON.stringify(b);

export function ModesSection() {
  const saved = useModes();
  const [list, setList] = useState<ModePreset[]>(saved);
  const [open, setOpen] = useState<string | null>(null);
  /** まだ保存していない新しいモード(id を編集できる) */
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const dirty = !sameList(list, saved);

  // 保存済みの一覧が変わったら(ほかの端末で保存したときも)、編集していなければ合わせる
  useEffect(() => {
    if (!dirty) setList(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const update = (i: number, patch: Partial<ModePreset>) => {
    setNote(null);
    setList((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  };
  const move = (i: number, d: -1 | 1) => {
    setNote(null);
    setList((l) => {
      const j = i + d;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const remove = (i: number) => {
    setNote(null);
    setList((l) => l.filter((_, j) => j !== i));
  };
  const add = () => {
    let n = 1;
    while (list.some((m) => m.id === `mode-${n}`)) n++;
    const id = `mode-${n}`;
    setList((l) => [...l, { id, label: `モード ${n}`, description: '', prompt: '', permissionMode: null, model: null, readOnly: false }]);
    setFresh((s) => new Set(s).add(id));
    setOpen(id);
    setNote(null);
  };
  const run = async (fn: () => Promise<ModePreset[]>, ok: string) => {
    setBusy(true);
    setErr(null);
    try {
      setList(await fn());
      setFresh(new Set());
      setNote(ok);
    } catch (e) {
      setErr(errText(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-sec">
      <section className="rp-card set-card" aria-labelledby="set-modes">
        <div className="set-card-head">
          <h3 id="set-modes" className="set-h">
            新規セッションのモード
          </h3>
        </div>
        <p className="muted small">
          新規セッションの画面の「モード」に並ぶものです。最初の指示の前に付ける言葉(スラッシュコマンドや決まった前置き)、
          最初の起動の権限モード、モデル、書き換えの禁止を組み合わせて作れます。commander と plain は PR の画面などでも使うので消せません。
        </p>
        <ul className="mode-list">
          {list.map((m, i) => {
            const builtin = BUILTIN_MODE_IDS.includes(m.id);
            const isOpen = open === m.id;
            return (
              <li key={i} className={`mode-item ${isOpen ? 'open' : ''}`}>
                <div className="mode-row">
                  <button type="button" className="mode-name" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen}>
                    <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> <b>{m.label}</b>
                    <span className="muted small mode-desc">{m.description}</span>
                  </button>
                  <span className="mode-tags">
                    {m.permissionMode === 'plan' && <span className="tag">計画</span>}
                    {m.readOnly && <span className="tag">書き換えなし</span>}
                    {m.model && <span className="tag">{SESSION_MODELS.find((x) => x.id === m.model)?.label ?? m.model}</span>}
                  </span>
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${m.label} を上へ`} title="上へ">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={i === list.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={`${m.label} を下へ`}
                    title="下へ"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={builtin}
                    onClick={() => remove(i)}
                    aria-label={`${m.label} を削除`}
                    title={builtin ? 'このモードは消せません' : '削除'}
                  >
                    ×
                  </button>
                </div>
                {isOpen && (
                  <div className="mode-edit form">
                    <div className="mode-grid">
                      <label className="field">
                        <span>表示名</span>
                        <input value={m.label} maxLength={20} onChange={(e) => update(i, { label: e.target.value })} />
                      </label>
                      <label className="field">
                        <span>id</span>
                        <input
                          className="mono"
                          value={m.id}
                          maxLength={32}
                          disabled={!fresh.has(m.id)}
                          onChange={(e) => {
                            const id = e.target.value.toLowerCase();
                            setFresh((s) => {
                              const n = new Set(s);
                              n.delete(m.id);
                              n.add(id);
                              return n;
                            });
                            setOpen(id);
                            update(i, { id });
                          }}
                          title={fresh.has(m.id) ? '英小文字・数字・- で付けます' : '保存したモードの id は変えられません'}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>説明</span>
                      <input value={m.description} maxLength={200} onChange={(e) => update(i, { description: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>最初の指示の組み立て</span>
                      <textarea
                        rows={3}
                        value={m.prompt}
                        onChange={(e) => update(i, { prompt: e.target.value })}
                        placeholder="空なら指示をそのまま渡します"
                      />
                      <span className="hint">
                        <code>{'{{instruction}}'}</code> の所に画面で書いた指示が入ります。無いときは「ここの内容 + 空白 + 指示」になります(例:{' '}
                        <code>/code-review</code>)
                      </span>
                    </label>
                    <div className="mode-grid">
                      <label className="field">
                        <span>最初の起動の権限モード</span>
                        <select
                          value={m.permissionMode ?? ''}
                          onChange={(e) => update(i, { permissionMode: (e.target.value || null) as ModePermission | null })}
                        >
                          <option value="">CC Hub の設定のまま</option>
                          {MODE_PERMISSIONS.map((p) => (
                            <option key={p} value={p}>
                              {PERMISSION_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>モデル</span>
                        <select value={m.model ?? ''} onChange={(e) => update(i, { model: e.target.value || null })}>
                          <option value="">画面で選んだまま</option>
                          {SESSION_MODELS.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="check-inline set-inline">
                      <input type="checkbox" checked={m.readOnly} onChange={(e) => update(i, { readOnly: e.target.checked })} />
                      ファイルを書き換えさせない(Edit / Write を使わせない)
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {err && <div className="rp-alert error">{err}</div>}
        {note && !err && <div className="form-ok">{note}</div>}
        <div className="set-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={add}>
            + モードを追加
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
            既定に戻す
          </button>
          <span className="spacer" />
          {dirty && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => setList(saved)}>
              変更を取り消す
            </button>
          )}
          <button type="button" className="btn primary sm" disabled={busy || !dirty} onClick={() => void run(() => modeApi.save(list), '保存しました')}>
            保存
          </button>
        </div>
      </section>
      {confirmReset && (
        <ConfirmModal
          title="モードを既定に戻しますか?"
          confirmLabel="既定に戻す"
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void run(modeApi.reset, '既定の 6 つに戻しました');
          }}
        >
          <p>追加したモードと編集した内容は消えて、commander・plain・plan・review・fix・marketing の 6 つに戻ります。</p>
        </ConfirmModal>
      )}
    </div>
  );
}
