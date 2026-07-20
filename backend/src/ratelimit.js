// Простой пер-IP лимитер скользящим окном. API живёт за nginx того же сайта,
// наружу не торчит, так что этого достаточно против перебора слов.
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { auth: 30, submit: 12, photo: 40 };

const hits = new Map(); // ip → { t0, auth, submit, photo }

export function allow(ip, kind) {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now - rec.t0 > WINDOW_MS) {
    rec = { t0: now, auth: 0, submit: 0, photo: 0 };
    hits.set(ip, rec);
  }
  // сборка мусора: выкидываем только протухшие окна, а не всех разом —
  // иначе поток фейковых IP сбрасывал бы счётчики настоящим
  if (hits.size > 10000) {
    for (const [k, v] of hits) {
      if (now - v.t0 > WINDOW_MS) hits.delete(k);
    }
  }
  rec[kind] += 1;
  return rec[kind] <= (LIMITS[kind] || 30);
}
