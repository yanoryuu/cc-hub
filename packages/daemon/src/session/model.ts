// 新規セッションのモデル指定(StartSessionRequest.model)の検証。
import { isSessionModel } from '@cc-hub/shared';
import { HttpError } from '../util';

/** StartSessionRequest.model を検証する。省略・空は undefined、知らない値は 400 */
export function sessionModel(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  if (!isSessionModel(v)) throw new HttpError(400, `モデルの指定が不正です: ${String(v).slice(0, 40)}`);
  return v;
}
