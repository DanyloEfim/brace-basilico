// Vercel serverless function: the only place that knows the API key.
// Set ANTHROPIC_API_KEY in Vercel -> Project -> Settings -> Environment Variables.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

const MENU = [
  ["Margherita", 6.5, "San Marzano tomato, fior di latte, basil, olive oil", "vegetarian"],
  ["Marinara", 5.5, "Tomato, garlic, oregano, olive oil", "vegan, no lactose"],
  ["Diavola", 8.5, "Tomato, fior di latte, spicy salami, chili oil", "spicy"],
  ["Bufala e Pomodorini", 10, "Buffalo mozzarella, yellow and red cherry tomatoes, basil", "vegetarian"],
  ["Salsiccia e Friarielli", 9.5, "Fior di latte, Neapolitan sausage, friarielli greens", ""],
  ["Montanara", 7, "Fried and baked dough, tomato, parmigiano, basil", "vegetarian"],
  ["Tiramisu della casa", 5, "Mascarpone, coffee, cocoa", "dessert"],
  ["House red, glass", 4.5, "Aglianico from Campania", "drink"],
];

function systemPrompt() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Rome",
  });
  return `You are the friendly assistant of "Brace & Basilico", a wood-fired Neapolitan pizzeria in Naples (a demo restaurant).
Always answer in the language the guest writes in. Keep answers short and warm, like a good waiter: 1 to 4 sentences, plain text, no markdown, no lists unless the guest asks for the menu.
Facts (never invent anything beyond these; if unsure, say you'll ask the staff):
- Address: Vicolo del Forno 12, Napoli. Phone: +39 081 000 0000 (demo).
- Open Tuesday to Sunday 12:00-15:00 and 19:00-23:30. Closed on Mondays. Bookings 12:00-14:30 and 19:00-22:30.
- Delivery 19:00-23:00 within 3 km, fee 2.50 euro, order by phone. Takeaway any opening hour.
- Menu with prices in euro: ${MENU.map(([n, p, d, t]) => `${n} ${p} (${d}${t ? "; " + t : ""})`).join("; ")}.
- Gluten-free dough is not available. Lactose-free and vegan: Marinara. The dough rests 48 hours.
- Tables seat up to 8 guests; for 9 or more, ask them to call.
- The restaurant cat, a fat orange tabby, is famous for stealing the last slice. Mention it only if asked or once as a light joke.
Bookings: you need date, time, number of guests and a name. Ask only for what is missing. Convert dates to YYYY-MM-DD and times to HH:MM. First call check_availability. If available, repeat the details and ask the guest to confirm; only after a clear yes, call create_booking. Never say a table is booked unless create_booking returned ok.
Today is ${today} (Europe/Rome).
Only talk about the restaurant. Politely decline unrelated requests.`;
}

const TOOLS = [
  {
    name: "check_availability",
    description: "Check if a table is available. date YYYY-MM-DD, time HH:MM (24h), guests number.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string" }, time: { type: "string" }, guests: { type: "integer" } },
      required: ["date", "time", "guests"],
    },
  },
  {
    name: "create_booking",
    description: "Create the booking after the guest clearly confirmed the details.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, date: { type: "string" }, time: { type: "string" }, guests: { type: "integer" },
      },
      required: ["name", "date", "time", "guests"],
    },
  },
];

function checkAvailability({ date, time, guests }) {
  const d = new Date(`${date}T12:00:00Z`);
  if (isNaN(d)) return { available: false, reason: "invalid date" };
  const day = d.getUTCDay();
  if (day === 1) return { available: false, reason: "closed on Mondays" };
  const [h, m] = String(time).split(":").map(Number);
  const t = h * 60 + (m || 0);
  const ok = (t >= 720 && t <= 870) || (t >= 1140 && t <= 1350);
  if (!ok) return { available: false, reason: "outside booking hours: 12:00-14:30 and 19:00-22:30" };
  if (guests > 8) return { available: false, reason: "9 or more guests: please call the restaurant" };
  if (day === 6 && t >= 1230 && t <= 1290 && guests > 4)
    return { available: false, reason: "large tables fully booked at that time", alternatives: ["19:30", "22:00"] };
  return { available: true };
}

// Best-effort limit per visitor (each serverless instance keeps its own counter).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((x) => now - x < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 30; // 30 messages per 10 minutes
}

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: systemPrompt(), tools: TOOLS, messages }),
  });
  if (!r.ok) throw new Error(`api ${r.status}: ${await r.text()}`);
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key is not set" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "busy" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const incoming = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = incoming
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user")
    return res.status(400).json({ error: "last message must be from the guest" });

  try {
    let booking = null;
    for (let step = 0; step < 4; step++) {
      const out = await callClaude(messages);
      const uses = out.content.filter((c) => c.type === "tool_use");
      if (out.stop_reason !== "tool_use" || !uses.length) {
        const reply = out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        return res.status(200).json({ reply, booking });
      }
      messages.push({ role: "assistant", content: out.content });
      const results = uses.map((u) => {
        let result;
        if (u.name === "check_availability") result = checkAvailability(u.input);
        else if (u.name === "create_booking") {
          booking = { ...u.input, code: "BB-" + Math.random().toString(36).slice(2, 6).toUpperCase() };
          result = { ok: true, code: booking.code };
        } else result = { error: "unknown tool" };
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(result) };
      });
      messages.push({ role: "user", content: results });
    }
    return res.status(200).json({ reply: "Sorry, let me check with the staff. Could you repeat that?", booking });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "assistant unavailable" });
  }
};
