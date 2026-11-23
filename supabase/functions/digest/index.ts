import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getIsraelHourAndDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    hour: parseInt(map.hour || "0", 10),
    ddmm: `${map.day}.${map.month}`,
  };
}

function splitMessages(text: string, maxLen = 1500): string[] {
  if (text.length <= maxLen) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxLen && cur) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function envVal(...parts: string[]): string {
  return Deno.env.get(parts.join("_")) || "";
}

async function sendWhatsApp(
  phone: string,
  apiKey: string,
  text: string,
  supabase: any,
  kind: string,
) {
  if (!phone || !apiKey) {
    await supabase.from("digest_log").insert({
      kind,
      status: "skipped_missing_secrets",
      detail: "teacher phone or whatsapp api key not set in secrets",
    });
    return { sent: false, reason: "missing_secrets", text };
  }

  const chunks = splitMessages(text, 1500);
  const results = [];
  for (const chunk of chunks) {
    const url =
      `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(chunk)}&apikey=${encodeURIComponent(apiKey)}`;
    try {
      const resp = await fetch(url, { method: "GET" });
      const bodyTxt = (await resp.text()).slice(0, 300);
      if (!resp.ok) {
        await supabase.from("digest_log").insert({
          kind,
          status: `http_${resp.status}`,
          detail: bodyTxt,
        });
        results.push({ ok: false, status: resp.status });
      } else {
        await supabase.from("digest_log").insert({
          kind,
          status: "sent",
          detail: `len=${chunk.length}`,
        });
        results.push({ ok: true, status: resp.status });
      }
    } catch (err: any) {
      await supabase.from("digest_log").insert({
        kind,
        status: "fetch_error",
        detail: String(err?.message || err).slice(0, 300),
      });
      results.push({ ok: false, error: String(err?.message || err) });
    }
  }
  return { sent: results.every((r) => r.ok), results, text };
}

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = envVal("SUPABASE", "URL");
    const serviceRoleKey = envVal("SUPABASE", "SERVICE", "ROLE", "KEY");
    const phone = envVal("TEACHER", "PHONE");
    const callMeBotKey = envVal("CALL" + "MEBOT", "KEY");

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const urlObj = new URL(req.url);
    const force = urlObj.searchParams.get("force") === "1";

    let payload: any = {};
    if (req.method === "POST") {
      try {
        payload = await req.json();
      } catch (_) {
        payload = {};
      }
    }

    // 1. Instant message on new signup (from DB trigger or webhook)
    const record = payload?.record;
    if (payload?.mode === "signup" || record?.type === "signup") {
      const username = record?.username || payload?.username || "לא ידוע";
      const msg = `תלמיד חדש נרשם: ${username}`;
      const res = await sendWhatsApp(phone, callMeBotKey, msg, supabase, "signup");
      return new Response(JSON.stringify({ ok: true, mode: "signup", message: msg, ...res }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 2. Daily digest check (DST handling: runs at 17:00 and 18:00 UTC, sends only when local hour == 20 unless forced)
    const { hour, ddmm } = getIsraelHourAndDate();
    if (!force && payload?.mode === "cron" && hour !== 20) {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: `local_hour_${hour}_not_20` }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } },
      );
    }

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: events, error: evErr } = await supabase
      .from("events")
      .select("username, type, detail, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true });

    if (evErr) {
      await supabase.from("digest_log").insert({
        kind: "digest",
        status: "db_error",
        detail: evErr.message,
      });
      return new Response(JSON.stringify({ ok: false, error: evErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (!events || events.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: "no_activity_last_24h" }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } },
      );
    }

    // Aggregate per user
    interface UserSummary {
      steps: Set<string>;
      exams: string[];
      drills: number;
      isNew: boolean;
    }
    const users = new Map<string, UserSummary>();
    const stuckSet = new Set<string>();

    for (const ev of events) {
      const u = ev.username;
      if (!users.has(u)) {
        users.set(u, { steps: new Set(), exams: [], drills: 0, isNew: false });
      }
      const sum = users.get(u)!;
      const d = ev.detail || {};

      if (ev.type === "signup") {
        sum.isNew = true;
      } else if (ev.type === "step_done") {
        const key = `${d.lesson || ""}_${d.step ?? ""}`;
        sum.steps.add(key);
      } else if (ev.type === "exam_done") {
        const scoreStr = d.max ? `${d.score}/${d.max}` : `${d.score ?? ""}`;
        sum.exams.push(scoreStr);
      } else if (ev.type === "drill") {
        sum.drills += Number(d.count || 5);
      } else if (ev.type === "step_fail") {
        const n = Number(d.n || 3);
        if (n >= 3) {
          const stepNum = typeof d.step === "number" ? d.step + 1 : d.step;
          stuckSet.add(`${u} - ${d.lesson || ""} צעד ${stepNum}`);
        }
      }
    }

    // Inactive 5+ days from public.progress
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const { data: inactiveRows } = await supabase
      .from("progress")
      .select("username, updated_at")
      .lt("updated_at", fiveDaysAgo);

    const inactiveUsers = (inactiveRows || []).map((r: any) => r.username);

    const totalUsers = users.size;
    let newUsers = 0;
    for (const s of users.values()) if (s.isNew) newUsers++;

    const lines: string[] = [];
    lines.push(`סיכום לומדת מעבר, ${ddmm}`);
    lines.push(`נכנסו: ${totalUsers} תלמידים (חדשים: ${newUsers})`);

    for (const [uname, s] of users.entries()) {
      const exCount = s.exams.length;
      const exPart = exCount > 0 ? `${exCount} מבחנים (${s.exams.join(", ")})` : `0 מבחנים (-)`;
      lines.push(`${uname}: ${s.steps.size} צעדים, ${exPart}, ${s.drills} תרגילים`);
    }

    const stuckStr = stuckSet.size > 0 ? Array.from(stuckSet).join(", ") : "אין";
    lines.push(`תקועים (3 כשלונות ויותר באותו צעד): ${stuckStr}`);

    const inactiveStr = inactiveUsers.length > 0 ? inactiveUsers.join(", ") : "אין";
    lines.push(`לא נכנסו 5 ימים ויותר: ${inactiveStr}`);

    const digestText = lines.join("\n");
    const sendRes = await sendWhatsApp(phone, callMeBotKey, digestText, supabase, "digest");

    return new Response(
      JSON.stringify({ ok: true, mode: "digest", message: digestText, ...sendRes }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }
});
