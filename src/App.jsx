// @ts-nocheck
import { useState, useMemo } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const AOW_AGE = 67;
const AOW_FRANCHISE = 19172;
const MAX_GRONDSLAG = 137800;
const TAX_RATE = 0.369; // box 1 marginal for lijfrente deduction

const PROFILES = [
  { id: "defensief",     label: "Defensief",     color: "#378ADD", bg: "#E6F1FB", text: "#0C447C", border: "#378ADD",  pessimistic: 1.5, expected: 2.5, optimistic: 3.5,  alloc: { "Obligaties & Cash": 70, "Aandelen": 20, "Alternatieven": 10 }, desc: "Kapitaalbehoud staat voorop. Lage volatiliteit, bescheiden rendement." },
  { id: "gebalanceerd",  label: "Gebalanceerd",  color: "#1D9E75", bg: "#E1F5EE", text: "#085041", border: "#1D9E75",  pessimistic: 0,   expected: 4.5, optimistic: 7,    alloc: { "Obligaties & Cash": 40, "Aandelen": 50, "Alternatieven": 10 }, desc: "Mix van stabiliteit en groei. Accepteert matige schommelingen." },
  { id: "offensief",     label: "Offensief",     color: "#EF9F27", bg: "#FAEEDA", text: "#633806", border: "#EF9F27",  pessimistic: -3,  expected: 6.5, optimistic: 11,   alloc: { "Obligaties & Cash": 15, "Aandelen": 75, "Alternatieven": 10 }, desc: "Gericht op groei. Accepteert flinke schommelingen voor hoger rendement." },
  { id: "zeer_offensief",label: "Zeer Offensief",color: "#D85A30", bg: "#FAECE7", text: "#712B13", border: "#D85A30",  pessimistic: -8,  expected: 9.0, optimistic: 16,   alloc: { "Obligaties & Cash": 5,  "Aandelen": 85, "Alternatieven": 10 }, desc: "Maximale groei. Hoog risico op kortetermijnverlies, hoogste langetermijnpotentieel." },
];

const ANNUITY_RATES = [
  { maxYears: 1, rate: 1.45 }, { maxYears: 2, rate: 1.75 }, { maxYears: 3, rate: 1.85 },
  { maxYears: 4, rate: 1.95 }, { maxYears: 5, rate: 2.10 }, { maxYears: 6, rate: 2.40 },
  { maxYears: 9, rate: 2.50 }, { maxYears: 10, rate: 2.55 }, { maxYears: 14, rate: 2.70 },
  { maxYears: 19, rate: 2.90 }, { maxYears: 999, rate: 3.10 },
];

// ─── Math helpers ─────────────────────────────────────────────────────────────
const fmt    = n => Math.round(n).toLocaleString("nl-NL");
const fmtEur = n => "€\u202f" + fmt(Math.abs(n));
const fmtM   = n => fmtEur(n) + "/mnd";

function annuityRate(yrs) {
  return (ANNUITY_RATES.find(r => yrs <= r.maxYears) || ANNUITY_RATES.at(-1)).rate;
}
function fv(monthly, pct, years) {
  if (years <= 0 || monthly <= 0) return 0;
  const r = pct / 100 / 12;
  return r === 0 ? monthly * 12 * years : monthly * ((Math.pow(1 + r, years * 12) - 1) / r);
}
function pmt(pot, payoutYears) {
  if (pot <= 0 || payoutYears <= 0) return 0;
  const r = annuityRate(payoutYears) / 100 / 12;
  const n = payoutYears * 12;
  return r === 0 ? pot / n : pot * r / (1 - Math.pow(1 + r, -n));
}
function jaarruimte(income, factorA) {
  const g = Math.min(Math.max(0, income - AOW_FRANCHISE), MAX_GRONDSLAG);
  return Math.max(0, Math.round(0.30 * g - 6.27 * factorA));
}

// ─── Budget allocation engine ─────────────────────────────────────────────────
// Given a fixed monthly budget and two goals (bridge + pension), allocate based on priority.
// priority: "bridge" | "pension" | "equal"
// Returns { bridgeMonthly, pensionMonthly, lijfrenteMonthly, vrijMonthly, canFullyFund, shortfall }
function allocate({ budget, priority, bridgeTarget, pensionTarget, jr, yearsToEarly, yearsToRetirement, profileExpected }) {
  // How much monthly do we need for each goal (at expected return)?
  // Bridge: need to accumulate bridgeTarget in yearsToEarly years (vrij beleggen)
  // Pension: need to accumulate pensionTarget in yearsToRetirement years (lijfrente/vrij)
  const bridgeNeeded  = bridgeTarget  > 0 && yearsToEarly      > 0 ? bridgeTarget  / ((Math.pow(1 + profileExpected / 100 / 12, yearsToEarly * 12) - 1) / (profileExpected / 100 / 12)) : 0;
  const pensionNeeded = pensionTarget > 0 && yearsToRetirement > 0 ? pensionTarget / ((Math.pow(1 + profileExpected / 100 / 12, yearsToRetirement * 12) - 1) / (profileExpected / 100 / 12)) : 0;

  let bridgeMonthly  = 0;
  let pensionMonthly = 0;

  if (priority === "bridge") {
    bridgeMonthly  = Math.min(budget, bridgeNeeded || budget);
    pensionMonthly = Math.min(Math.max(0, budget - bridgeMonthly), pensionNeeded || budget);
  } else if (priority === "pension") {
    // If pensionNeeded is 0 (not yet calculated), allocate full budget to pension
    pensionMonthly = pensionNeeded > 0 ? Math.min(budget, pensionNeeded) : budget;
    bridgeMonthly  = Math.min(Math.max(0, budget - pensionMonthly), bridgeNeeded);
  } else {
    // equal: split proportionally to need, or 50/50 if needs unknown
    const total = bridgeNeeded + pensionNeeded;
    if (total > 0) {
      bridgeMonthly  = Math.min(budget * (bridgeNeeded / total), bridgeNeeded);
      pensionMonthly = Math.min(budget * (pensionNeeded / total), pensionNeeded);
    } else {
      pensionMonthly = budget;
    }
  }

  // Of the pension portion: up to jr/12 goes into lijfrente (tax-deductible)
  // If jr is 0 (not yet calculated), assume the full pension portion can go into lijfrente
  // The exact split is refined once Factor A is filled in
  const lijfrenteMax   = jr > 0 ? jr / 12 : pensionMonthly;
  const lijfrenteM     = Math.min(pensionMonthly, lijfrenteMax);
  const vrijPensionM   = Math.max(0, pensionMonthly - lijfrenteM);

  const shortfall = Math.max(0, (bridgeNeeded + pensionNeeded) - budget);

  return {
    bridgeMonthly:   Math.round(bridgeMonthly),
    pensionMonthly:  Math.round(pensionMonthly),
    lijfrenteMonthly: Math.round(lijfrenteM),
    vrijMonthly:     Math.round(bridgeMonthly + vrijPensionM), // all vrij = bridge + excess pension
    shortfall:       Math.round(shortfall),
    bridgeNeeded:    Math.round(bridgeNeeded),
    pensionNeeded:   Math.round(pensionNeeded),
    canFullyFund:    shortfall < 1,
  };
}

// ─── XML parser (verified against actual MPO export May 2026) ─────────────────
function parsePensionXML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parseerror")) throw new Error("Ongeldig XML bestand.");

  const byTag = (root, tag) => {
    const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = w.currentNode;
    while (n) { if ((n.localName || n.tagName?.split(":").pop() || "") === tag) out.push(n); n = w.nextNode(); }
    return out;
  };
  const first  = (root, tag) => byTag(root, tag)[0] || null;
  const txt    = (root, tag) => first(root, tag)?.textContent?.trim() || "";
  const num    = (root, tag) => { const v = parseFloat(txt(root, tag).replace(",", ".")); return isNaN(v) ? 0 : v; };

  const ouderdoms = byTag(doc, "OuderdomsPensioen");
  const lifetime  = ouderdoms.find(b => byTag(b, "Overlijden").length > 0) || ouderdoms.at(-1);
  if (!lifetime) throw new Error("Geen pensioengegevens gevonden. Is dit het juiste XML bestand van mijnpensioenoverzicht.nl?");

  const results = [];

  // AOW — show opgebouwd (what's accrued now), and tebereiken (what they'll get at AOW age)
  const aowOpbouw   = first(lifetime, "AOWDetailsOpbouw");
  const situatie    = txt(doc, "LevensSituatie");
  const samen       = situatie !== "Alleenstaand";
  const aowOpgebouwd   = aowOpbouw ? num(aowOpbouw, samen ? "OpgebouwdSamenwonend"   : "OpgebouwdAlleenstaand")   : 0;
  const aowTeBereiken  = aowOpbouw ? num(aowOpbouw, samen ? "TeBereikenSamenwonend"  : "TeBereikenAlleenstaand")  : 0;
  if (aowTeBereiken > 0 || aowOpgebouwd > 0) {
    results.push({ naam: "AOW (Sociale Verzekeringsbank)", soort: "AOW", brutoJaar: Math.round(aowOpgebouwd), brutoJaarTeBereiken: Math.round(aowTeBereiken), brutoMaand: Math.round(aowOpgebouwd / 12) });
  }

  // Employer pensions: direct Pensioen / IndicatiefPensioen children of the lifetime block
  Array.from(lifetime.childNodes).forEach(node => {
    const tag = node.localName || node.tagName || "";
    if (tag !== "Pensioen" && tag !== "IndicatiefPensioen") return;
    const naam     = txt(node, "PensioenUitvoerder");
    const brutoJaar = num(node, "TeBereiken");
    if (!naam || brutoJaar <= 0) return;
    results.push({ naam, soort: tag === "IndicatiefPensioen" ? "Indicatief Pensioen (DC)" : "Pensioen (DB)", brutoJaar: Math.round(brutoJaar), brutoMaand: Math.round(brutoJaar / 12) });
  });

  if (results.length === 0) throw new Error("Geen pensioengegevens gevonden. Is dit het juiste XML bestand van mijnpensioenoverzicht.nl?");
  return results;
}

// ─── UI primitives ────────────────────────────────────────────────────────────
function Progress({ step, total }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>Pensioenplan</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{step} / {total}</span>
      </div>
      <div style={{ height: 4, background: "var(--color-border-tertiary)", borderRadius: 2 }}>
        <div style={{ height: 4, width: `${(step / total) * 100}%`, background: "#1D9E75", borderRadius: 2, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function Q({ label, sub, children }) {
  return (
    <div>
      <p style={{ fontSize: 20, fontWeight: 500, lineHeight: 1.4, margin: "0 0 6px", color: "var(--color-text-primary)" }}>{label}</p>
      {sub && <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: "0 0 18px", lineHeight: 1.65 }}>{sub}</p>}
      {children}
    </div>
  );
}

function Tip({ children, color = "#E1F5EE", textColor = "#085041", borderColor = "#5DCAA5" }) {
  return <div style={{ background: color, border: `0.5px solid ${borderColor}`, borderRadius: "var(--border-radius-md)", padding: "11px 14px", marginBottom: 18 }}><p style={{ margin: 0, fontSize: 14, color: textColor, lineHeight: 1.65 }}>{children}</p></div>;
}

function Choice({ label, sub, selected, onClick, tag }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left", padding: "14px 16px", marginBottom: 10,
      background: selected ? "#E1F5EE" : "var(--color-background-primary)",
      border: selected ? "1.5px solid #1D9E75" : "0.5px solid var(--color-border-secondary)",
      borderRadius: "var(--border-radius-md)", cursor: "pointer", fontFamily: "var(--font-sans)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: selected ? "#085041" : "var(--color-text-primary)" }}>{label}</p>
        {tag && <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 10, background: selected ? "#1D9E75" : "var(--color-border-tertiary)", color: selected ? "#fff" : "var(--color-text-secondary)", flexShrink: 0, marginLeft: 8 }}>{tag}</span>}
      </div>
      {sub && <p style={{ margin: "4px 0 0", fontSize: 13, color: selected ? "#0F6E56" : "var(--color-text-secondary)", lineHeight: 1.5 }}>{sub}</p>}
    </button>
  );
}

function Btn({ children, onClick, disabled, variant = "primary" }) {
  if (variant === "ghost") return (
    <button onClick={onClick} style={{ padding: "11px 18px", fontSize: 14, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "var(--font-sans)" }}>{children}</button>
  );
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: "11px 26px", fontSize: 15, fontWeight: 500, border: "none", borderRadius: "var(--border-radius-md)", background: disabled ? "var(--color-border-tertiary)" : "#1D9E75", color: disabled ? "var(--color-text-tertiary)" : "#fff", cursor: disabled ? "default" : "pointer", fontFamily: "var(--font-sans)" }}>{children}</button>
  );
}

function Skip({ children, onClick }) {
  return <button onClick={onClick} style={{ background: "none", border: "none", color: "#1D9E75", fontSize: 14, cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "var(--font-sans)" }}>{children}</button>;
}

function Field({ value, onChange, prefix = "€", placeholder, suffix, max = 280 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 14px", background: "var(--color-background-primary)", maxWidth: max }}>
      {prefix && <span style={{ fontSize: 14, color: "var(--color-text-secondary)", flexShrink: 0 }}>{prefix}</span>}
      <input type="number" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ border: "none", outline: "none", fontSize: 16, fontFamily: "var(--font-sans)", background: "transparent", color: "var(--color-text-primary)", width: "100%" }} />
      {suffix && <span style={{ fontSize: 14, color: "var(--color-text-secondary)", flexShrink: 0 }}>{suffix}</span>}
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: accent || "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px" }}>
      <p style={{ margin: "0 0 2px", fontSize: 12, color: accent ? "#0F6E56" : "var(--color-text-secondary)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</p>
      <p style={{ margin: "0 0 2px", fontSize: 20, fontWeight: 500, color: accent ? "#085041" : "var(--color-text-primary)" }}>{value}</p>
      {sub && <p style={{ margin: 0, fontSize: 12, color: accent ? "#0F6E56" : "var(--color-text-tertiary)" }}>{sub}</p>}
    </div>
  );
}

function AllocBar({ label, pct, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ width: 150, fontSize: 13, color: "var(--color-text-secondary)", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 7, background: "var(--color-border-tertiary)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
      </div>
      <span style={{ width: 34, textAlign: "right", fontSize: 13, fontWeight: 500 }}>{pct}%</span>
    </div>
  );
}

function BudgetBar({ label, amount, total, color, sub }) {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>{label}</span>
          {sub && <span style={{ fontSize: 12, color: "var(--color-text-secondary)", marginLeft: 8 }}>{sub}</span>}
        </div>
        <span style={{ fontSize: 15, fontWeight: 500 }}>{fmtM(amount)}</span>
      </div>
      <div style={{ height: 8, background: "var(--color-border-tertiary)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
const STEPS = ["intro","vision","age","income","xml","pension_check","gap","budget","priority","factorA","monthly","risk","scenario","plan"];
const TOTAL  = 10; // visible steps (excluding intro, scenario, plan)

export default function App() {
  const [step,           setStep]          = useState("intro");
  const [vision,         setVision]        = useState(null);       // "full" | "early"
  const [earlyAge,       setEarlyAge]      = useState("58");
  const [earlyDays,      setEarlyDays]     = useState("3");
  const [currentAge,     setCurrentAge]    = useState("");
  const [grossIncome,    setGrossIncome]   = useState("");
  const [pensionPots,    setPensionPots]   = useState(null);
  const [xmlError,       setXmlError]      = useState(null);
  const [dragging,       setDragging]      = useState(false);
  const [pensionFeeling, setPensionFeeling]= useState(null);       // "enough" | "more"
  const [desiredTotal,   setDesiredTotal]  = useState("");
  const [budget,         setBudget]        = useState("");
  const [priority,       setPriority]      = useState(null);       // "bridge" | "pension" | "equal"
  const [factorA,        setFactorA]       = useState("");
  const [confirmedIdx,   setConfirmedIdx]  = useState(null);
  const [termsAccepted,  setTermsAccepted] = useState(false);
  const [manualPension,  setManualPension] = useState("");
  const [riskChoice,     setRiskChoice]    = useState(null);

  // ── Derived values ──────────────────────────────────────────────────────────
  const age            = parseInt(currentAge)   || 42;
  const income         = parseFloat(grossIncome) || 60000;
  const fA             = parseFloat(factorA)    || 0;
  const jr             = jaarruimte(income, fA);
  const earlyAgeN      = parseInt(earlyAge)     || 58;
  const earlyDaysN     = parseFloat(earlyDays)  || 3;
  const budgetN        = parseFloat(budget)     || 0;
  const profileIdx     = confirmedIdx !== null ? confirmedIdx : (riskChoice !== null ? riskChoice : 1);
  const profile        = PROFILES[profileIdx];

  const yearsToEarly       = Math.max(0, earlyAgeN - age);
  const yearsToRetirement  = Math.max(0, AOW_AGE - age);
  const yearsToBridge      = Math.max(0, AOW_AGE - earlyAgeN);
  const incomeReduction    = (5 - earlyDaysN) / 5;
  const bridgeMonthGap     = Math.round((income / 12) * incomeReduction);

  const existingTotal  = pensionPots ? pensionPots.reduce((s, p) => s + p.brutoMaand, 0) : (parseFloat(manualPension) || 0);
  const desiredN       = parseFloat(desiredTotal) || Math.round(income * 0.75 / 12);
  const pensionGap     = Math.max(0, desiredN - existingTotal);

  // Targets in € (lump sum pot needed)
  // Bridge: monthly gap × months, discounted — just use the nominal total as conservative target
  const bridgePotTarget   = vision === "early" ? bridgeMonthGap * yearsToBridge * 12 : 0;
  // Pension: pot needed to generate the gap as monthly income via annuity
  const pensionPayoutYears = vision === "early" ? yearsToBridge : 20;
  const _ar = annuityRate(pensionPayoutYears) / 100 / 12;
  const _an = pensionPayoutYears * 12;
  const pensionPotTarget  = pensionGap > 0 ? pensionGap / (_ar === 0 ? 1/_an : _ar / (1 - Math.pow(1+_ar,-_an))) : 0;

  const alloc = useMemo(() => allocate({
    budget: budgetN,
    priority: priority || "equal",
    bridgeTarget:  bridgePotTarget,
    pensionTarget: pensionPotTarget,
    jr,
    yearsToEarly,
    yearsToRetirement,
    profileExpected: profile.expected,
  }), [budgetN, priority, bridgePotTarget, pensionPotTarget, jr, yearsToEarly, yearsToRetirement, profile.expected]);

  // Projected outcomes
  const potLijfrente = fv(alloc.lijfrenteMonthly, profile.expected, yearsToRetirement);
  const potVrij      = fv(alloc.vrijMonthly,      profile.expected, yearsToEarly || yearsToRetirement);
  const potPension   = fv(alloc.pensionMonthly,   profile.expected, yearsToRetirement);
  const extraMonthly = Math.round(pmt(potPension, pensionPayoutYears));
  const totalAtRet   = existingTotal + extraMonthly;
  const taxSaving    = Math.round(alloc.lijfrenteMonthly * 12 * TAX_RATE);

  const stepNum = Math.max(1, STEPS.indexOf(step) - 1);

  function go(s) { setStep(s); window.scrollTo && window.scrollTo(0, 0); }

  function handleXml(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = e => { try { setPensionPots(parsePensionXML(e.target.result)); setXmlError(null); } catch (err) { setXmlError(err.message); } };
    r.readAsText(file);
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 0 4rem", fontFamily: "var(--font-sans)" }}>

      {/* ══ INTRO ══════════════════════════════════════════════════════════════ */}
      {step === "intro" && (
        <div>
          <span style={{ display: "inline-block", background: "#E1F5EE", color: "#085041", fontSize: 12, fontWeight: 500, padding: "4px 14px", borderRadius: 20, marginBottom: 20, letterSpacing: "0.04em" }}>Extra pensioen · Persoonlijk plan</span>
          <h1 style={{ fontSize: 28, fontWeight: 500, lineHeight: 1.35, margin: "0 0 14px" }}>Wat is voor jou het belangrijkst?</h1>
          <p style={{ fontSize: 16, color: "var(--color-text-secondary)", lineHeight: 1.75, margin: "0 0 28px" }}>
            Iedereen heeft een beperkt bedrag om opzij te zetten. We helpen je dat slim te verdelen — op basis van wat voor jou het meest telt. Eén vraag tegelijk, geen formulieren.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 28 }}>
            {[
              { icon: "ti-coin", label: "Jouw budget",      sub: "Staat centraal" },
              { icon: "ti-arrow-fork", label: "Jouw prioriteit", sub: "Stuurt de verdeling" },
              { icon: "ti-file-text", label: "Volledig plan",  sub: "Van nu tot later" },
            ].map(({ icon, label, sub }) => (
              <div key={label} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "14px 12px", textAlign: "center" }}>
                <i className={`ti ${icon}`} aria-hidden="true" style={{ fontSize: 22, color: "#1D9E75", display: "block", marginBottom: 6 }} />
                <p style={{ margin: "0 0 2px", fontSize: 14, fontWeight: 500 }}>{label}</p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-secondary)" }}>{sub}</p>
              </div>
            ))}
          </div>
          <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 18, marginBottom: 24 }}>
            <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: 0, lineHeight: 1.6 }}>Ter oriëntatie — geen financieel advies. Raadpleeg een adviseur voor een persoonlijk advies.</p>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 20, padding: "14px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
            <input
              type="checkbox"
              id="terms"
              checked={termsAccepted}
              onChange={e => setTermsAccepted(e.target.checked)}
              style={{ marginTop: 3, width: 16, height: 16, accentColor: "#1D9E75", flexShrink: 0, cursor: "pointer" }}
            />
            <label htmlFor="terms" style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.65, cursor: "pointer" }}>
              Ik begrijp dat deze tool uitsluitend bedoeld is voor <strong>educatieve doeleinden</strong> en geen financieel advies verstrekt. Mijn gegevens worden niet opgeslagen of gedeeld. Ik raadpleeg een gecertificeerd financieel adviseur voor persoonlijk pensioenadvies.
            </label>
          </div>
          <Btn onClick={() => go("vision")} disabled={!termsAccepted}>Start het gesprek →</Btn>
        </div>
      )}

      {/* ══ VISION ════════════════════════════════════════════════════════════ */}
      {step === "vision" && (
        <div>
          <Progress step={1} total={TOTAL} />
          <Q label="Hoe zie jij jouw pensioen voor je?" sub="Dit bepaalt welke doelen we in kaart brengen en hoe we jouw geld verdelen.">
            <Choice label="Ik werk door tot mijn AOW-leeftijd (67)" sub="En ga dan volledig met pensioen. Mijn focus is een goed inkomen ná mijn 67e." selected={vision === "full"} onClick={() => setVision("full")} tag="Lijfrente" />
            <Choice label="Ik wil eerder minder gaan werken" sub="Bijvoorbeeld stoppen of deeltijd gaan vóór mijn 67e. Ik heb dan overbruggingsgeld nodig." selected={vision === "early"} onClick={() => setVision("early")} tag="Vrij beleggen + Lijfrente" />
          </Q>
          {vision === "early" && (
            <div style={{ margin: "4px 0 20px", padding: "16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
              <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 500 }}>Vertel iets meer over jouw wens:</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Vanaf welke leeftijd wil je minder werken?</p>
                  <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--color-text-tertiary)" }}>Bijv. vanaf je 58e of 60e</p>
                  <Field value={earlyAge} onChange={setEarlyAge} prefix="Leeftijd" placeholder="58" />
                </div>
                <div>
                  <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Hoeveel dagen per week blijf je dan nog werken?</p>
                  <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--color-text-tertiary)" }}>Op een werkweek van 5 dagen</p>
                  <Field value={earlyDays} onChange={setEarlyDays} prefix="Dagen" placeholder="3" suffix="van de 5" />
                </div>
              </div>
              {earlyAge && earlyDays && (
                <div style={{ marginTop: 14, padding: "10px 12px", background: "#E1F5EE", borderRadius: "var(--border-radius-md)" }}>
                  <p style={{ margin: 0, fontSize: 13, color: "#085041", lineHeight: 1.6 }}>
                    Vanaf je <strong>{earlyAge}e</strong> werk je nog <strong>{earlyDays} van de 5 dagen</strong> — dat is {Math.round((5 - parseFloat(earlyDays)) / 5 * 100)}% minder inkomen tot je AOW op je 67e.
                  </p>
                </div>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <Btn onClick={() => go("age")} disabled={!vision}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ AGE ═══════════════════════════════════════════════════════════════ */}
      {step === "age" && (
        <div>
          <Progress step={2} total={TOTAL} />
          <Q label="Hoe oud ben je?" sub="Hiermee berekenen we hoeveel tijd je hebt om te sparen voor elk doel.">
            <Tip>Een schatting is prima — het gaat om de orde van grootte.</Tip>
            <Field value={currentAge} onChange={setCurrentAge} prefix="Leeftijd" placeholder="42" />
            {currentAge && !isNaN(currentAge) && (
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: vision === "early" ? "1fr 1fr" : "1fr", gap: 10 }}>
                {vision === "early" && <StatCard label="Tot deeltijdpensioen" value={`${yearsToEarly} jaar`} sub={`Vrij beleggen fase`} />}
                <StatCard label="Tot AOW (67)" value={`${yearsToRetirement} jaar`} sub="Lijfrente fase" />
              </div>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => go("vision")}>← Terug</Btn>
            <Btn onClick={() => go("income")} disabled={!currentAge || isNaN(currentAge)}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ INCOME ════════════════════════════════════════════════════════════ */}
      {step === "income" && (
        <div>
          <Progress step={3} total={TOTAL} />
          <Q label="Wat is je bruto jaarsalaris?" sub="Dit gebruiken we om je Jaarruimte te berekenen en een realistisch streefinkomen te schatten.">
            <Tip>Vind je dit op je loonstrook of jaaropgave. Gok gerust — we passen het later aan.</Tip>
            <Field value={grossIncome} onChange={setGrossIncome} placeholder="65000" />
            {grossIncome && (
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--color-text-tertiary)" }}>
                Streefinkomen bij pensioen (75%): <strong>{fmtM(Math.round(parseFloat(grossIncome) * 0.75 / 12))}</strong>
              </p>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => go("age")}>← Terug</Btn>
            <Btn onClick={() => go("xml")}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ XML UPLOAD ════════════════════════════════════════════════════════ */}
      {step === "xml" && (
        <div>
          <Progress step={4} total={TOTAL} />
          <Q label="Wat bouw je nu al op?" sub="Upload je XML van mijnpensioenoverzicht.nl — dan zien we direct wat er al staat. Volledig optioneel.">
            <Tip>Log in op <strong>mijnpensioenoverzicht.nl</strong> met DigiD → "Bekijk mijn pensioenoverzicht" → scroll naar beneden → "Download XML".</Tip>

            {!pensionPots && (
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); handleXml(e.dataTransfer.files[0]); }}
                onClick={() => document.getElementById("xf").click()}
                style={{ border: `1.5px dashed ${dragging ? "#1D9E75" : "var(--color-border-secondary)"}`, borderRadius: "var(--border-radius-lg)", padding: "32px 20px", textAlign: "center", background: dragging ? "#E1F5EE" : "var(--color-background-primary)", cursor: "pointer", marginBottom: 14 }}
              >
                <i className="ti ti-file-upload" aria-hidden="true" style={{ fontSize: 30, color: "#1D9E75", display: "block", marginBottom: 8 }} />
                <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 500 }}>Sleep je XML bestand hierheen</p>
                <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary)" }}>of klik om te uploaden</p>
                <input id="xf" type="file" accept=".xml" style={{ display: "none" }} onChange={e => handleXml(e.target.files[0])} />
              </div>
            )}

            {xmlError && <Tip color="#FCEBEB" textColor="#A32D2D" borderColor="#E24B4A">{xmlError}</Tip>}

            {pensionPots && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>Jouw pensioenpotten</p>
                  <Skip onClick={() => { setPensionPots(null); setXmlError(null); }}>Nieuw bestand</Skip>
                </div>
                {pensionPots.map((p, i) => {
                  const col = p.soort === "AOW" ? "#378ADD" : "#1D9E75";
                  return (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", marginBottom: 8 }}>
                      <div>
                        <p style={{ margin: "0 0 3px", fontSize: 14, fontWeight: 500 }}>{p.naam}</p>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: col + "22", color: col, fontWeight: 500 }}>{p.soort}</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <p style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 500 }}>{fmtM(p.brutoMaand)}</p>
                        <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-tertiary)" }}>{fmtEur(p.brutoJaar)}/jaar</p>
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "#E1F5EE", borderRadius: "var(--border-radius-md)" }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: "#085041" }}>Totaal bruto per maand</p>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "#085041" }}>{fmtM(existingTotal)}</p>
                </div>
              </div>
            )}
          </Q>
          {!pensionPots && (
            <div style={{ marginTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "16px 0 8px" }}>
                <div style={{ flex: 1, height: "0.5px", background: "var(--color-border-tertiary)" }} />
                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>of vul handmatig in</span>
                <div style={{ flex: 1, height: "0.5px", background: "var(--color-border-tertiary)" }} />
              </div>
              <p style={{ margin: "0 0 8px", fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                Weet je (bij benadering) hoeveel bruto pensioen je al opbouwt per maand? Inclusief AOW.
              </p>
              <Field value={manualPension} onChange={setManualPension} placeholder="bijv. 2500" suffix="/mnd" />
              {manualPension && (
                <p style={{ marginTop: 8, fontSize: 13, color: "var(--color-text-tertiary)" }}>
                  We gebruiken {fmtM(parseFloat(manualPension))} als jouw huidige pensioensituatie.
                </p>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => go("income")}>← Terug</Btn>
            <Btn onClick={() => go("pension_check")}>{pensionPots ? "Volgende →" : "Volgende →"}</Btn>
          </div>
        </div>
      )}

      {/* ══ PENSION CHECK ═════════════════════════════════════════════════════ */}
      {step === "pension_check" && (
        <div>
          <Progress step={5} total={TOTAL} />
          <Q label={pensionPots ? "Is dit genoeg voor jou?" : "Hoe voel je je over je pensioensituatie?"}>
            {pensionPots ? (
              <Tip>Je bouwt nu <strong>{fmtM(existingTotal)}</strong> op. Een gangbare vuistregel is 70–80% van je laatste salaris — voor jou is dat ongeveer <strong>{fmtM(Math.round(income * 0.75 / 12))}</strong>.</Tip>
            ) : existingTotal > 0 ? (
              <Tip>Op basis van jouw opgave bouw je nu <strong>{fmtM(existingTotal)}</strong> bruto per maand op. Een gangbare vuistregel is 70–80% van je laatste salaris — voor jou is dat ongeveer <strong>{fmtM(Math.round(income * 0.75 / 12))}</strong>.</Tip>
            ) : (
              <Tip>Je hebt geen pensioenoverzicht opgegeven. We gaan ervan uit dat je nog niets opgebouwd hebt — vul je streefbedrag in bij de volgende stap.</Tip>
            )}
            <Choice label="Dit is genoeg" sub="Ik hoef geen extra pensioen op te bouwen" selected={pensionFeeling === "enough"} onClick={() => setPensionFeeling("enough")} />
            <Choice label="Ik wil meer zekerheid" sub="Laat me zien hoe ik mijn pensioeninkomen kan aanvullen" selected={pensionFeeling === "more"} onClick={() => setPensionFeeling("more")} />
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => go("xml")}>← Terug</Btn>
            <Btn onClick={() => { if (pensionFeeling === "enough") go("plan_simple"); else go("gap"); }} disabled={!pensionFeeling}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ GAP ═══════════════════════════════════════════════════════════════ */}
      {step === "gap" && (
        <div>
          <Progress step={6} total={TOTAL} />
          <Q label="Hoeveel wil je bruto per maand ontvangen bij pensionering?" sub="Dit is je streefbedrag. We berekenen dan wat je nog moet aanvullen.">
            <Tip>{pensionPots ? `Je hebt nu ${fmtM(existingTotal)} opgebouwd.` : `Op basis van je salaris schatten we een tekort van ${fmtM(Math.round(income * 0.25 / 12))}.`} Vul hieronder je gewenste totaalinkomen in.</Tip>
            <Field value={desiredTotal} onChange={setDesiredTotal} placeholder={String(Math.round(income * 0.75 / 12))} suffix="/mnd" />
            {desiredTotal && (
              <div style={{ marginTop: 14 }}>
                {pensionGap > 0 ? (
                  <div style={{ background: "#FAEEDA", border: "0.5px solid #EF9F27", borderRadius: "var(--border-radius-md)", padding: "12px 14px" }}>
                    <p style={{ margin: "0 0 4px", fontSize: 13, color: "#854F0B", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pensioengat</p>
                    <p style={{ margin: "0 0 4px", fontSize: 24, fontWeight: 500, color: "#633806" }}>{fmtM(pensionGap)}</p>
                    <p style={{ margin: 0, fontSize: 13, color: "#854F0B" }}>{fmtM(existingTotal)} opgebouwd · {fmtM(desiredN)} gewenst</p>
                  </div>
                ) : (
                  <Tip>Je bestaande pensioen dekt je streefbedrag al. Je kunt altijd extra sparen voor meer zekerheid.</Tip>
                )}
              </div>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => go("pension_check")}>← Terug</Btn>
            <Btn onClick={() => go("budget")} disabled={!desiredTotal}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ BUDGET ════════════════════════════════════════════════════════════ */}
      {step === "budget" && (
        <div>
          <Progress step={7} total={TOTAL} />
          <Q label="Hoeveel kun je maandelijks opzijzetten?" sub="Dit is het totale bedrag dat je beschikbaar hebt voor al je pensioendoelen samen. Wij verdelen het daarna slim.">
            <Tip>Dit hoeft niet precies te zijn. Ga uit van wat je nu comfortabel kunt missen — je kunt het later aanpassen.</Tip>
            <Field value={budget} onChange={setBudget} placeholder="400" suffix="/mnd" />
            {budget && budgetN > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: vision === "early" ? "1fr 1fr 1fr" : "1fr 1fr", gap: 10 }}>
                  <StatCard label="Jaarlijks" value={fmtEur(budgetN * 12)} sub="totaal budget per jaar" />
                  {vision === "early" && <StatCard label="Tot deeltijdpensioen" value={fmtEur(budgetN * yearsToEarly * 12)} sub={`over ${yearsToEarly} jaar`} />}
                  <StatCard label="Tot AOW" value={fmtEur(budgetN * yearsToRetirement * 12)} sub={`over ${yearsToRetirement} jaar`} />
                </div>
              </div>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => go("gap")}>← Terug</Btn>
            <Btn onClick={() => go("priority")} disabled={!budget || budgetN <= 0}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ PRIORITY ══════════════════════════════════════════════════════════ */}
      {step === "priority" && (
        <div>
          <Progress step={8} total={TOTAL} />
          <Q
            label={vision === "early" ? "Wat vind je het belangrijkst?" : "Hoe wil je jouw budget verdelen?"}
            sub={`Je hebt ${fmtM(budgetN)} beschikbaar.${vision === "early" ? " Je hebt twee doelen die om dat geld concurreren. Waar leg jij de nadruk?" : " Hoe wil je dit inzetten voor extra pensioen?"}`}
          >
            {vision === "early" && (
              <div style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", marginBottom: 18 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <p style={{ margin: "0 0 2px", fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>DOEL 1 · EERDER STOPPEN</p>
                    <p style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 500 }}>{fmtM(bridgeMonthGap)}</p>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-tertiary)" }}>inkomensdaling · {yearsToBridge} jaar overbrugging</p>
                  </div>
                  <div>
                    <p style={{ margin: "0 0 2px", fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>DOEL 2 · EXTRA PENSIOEN</p>
                    <p style={{ margin: "0 0 2px", fontSize: 16, fontWeight: 500 }}>{fmtM(pensionGap)}</p>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-tertiary)" }}>tekort per maand · vanaf {AOW_AGE} jaar</p>
                  </div>
                </div>
              </div>
            )}

            {vision === "early" && (
              <Choice
                label="Eerder stoppen is mijn prioriteit"
                sub={`Ik zet eerst geld opzij voor de overbrugging (${fmtM(bridgeMonthGap)}/mnd tekort). Wat er overblijft gaat naar pensioen.`}
                tag="Vrij beleggen eerst"
                selected={priority === "bridge"}
                onClick={() => setPriority("bridge")}
              />
            )}
            <Choice
              label={vision === "early" ? "Extra pensioeninkomen is mijn prioriteit" : "Maximaal in lijfrente (fiscaal aftrekbaar)"}
              sub={vision === "early"
                ? `Ik vul eerst mijn pensioengat (${fmtM(pensionGap)}/mnd). Wat er overblijft gaat naar de overbrugging.`
                : `Beleg zoveel mogelijk fiscaal voordelig via lijfrente. Optimaal belastingvoordeel.`}
              tag="Lijfrente eerst"
              selected={priority === "pension"}
              onClick={() => setPriority("pension")}
            />
            <Choice
              label={vision === "early" ? "Beide zijn even belangrijk" : "Mix van lijfrente en vrij beleggen"}
              sub={vision === "early"
                ? "Verdeel het budget proportioneel over beide doelen."
                : "Deel van je budget in lijfrente (aftrekbaar), deel vrij beleggen (flexibel)."}
              tag="Gelijke verdeling"
              selected={priority === "equal"}
              onClick={() => setPriority("equal")}
            />

            {priority && budgetN > 0 && (
              <div style={{ marginTop: 18 }}>
                <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 500 }}>Zo verdelen we jouw {fmtM(budgetN)}:</p>
                {vision === "early" && <BudgetBar label="Vrij beleggen" sub="voor overbrugging" amount={alloc.bridgeMonthly} total={budgetN} color="#EF9F27" />}
                <BudgetBar label="Lijfrente" sub="fiscaal aftrekbaar" amount={alloc.lijfrenteMonthly} total={budgetN} color="#1D9E75" />
                {alloc.vrijMonthly - alloc.bridgeMonthly > 0 && <BudgetBar label="Vrij beleggen" sub="voor extra pensioen" amount={alloc.vrijMonthly - alloc.bridgeMonthly} total={budgetN} color="#378ADD" />}
                {alloc.shortfall > 0 && (
                  <Tip color="#FCEBEB" textColor="#A32D2D" borderColor="#E24B4A">
                    Met {fmtM(budgetN)} kun je niet alle doelen volledig financieren. Je hebt nog <strong>{fmtM(alloc.shortfall)}/mnd</strong> tekort. Je kunt je budget verhogen, of een doel bijstellen.
                  </Tip>
                )}
                {alloc.shortfall === 0 && (
                  <Tip>Met {fmtM(budgetN)} kun je beide doelen volledig financieren.</Tip>
                )}
              </div>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => go("budget")}>← Terug</Btn>
            <Btn onClick={() => go("factorA")} disabled={!priority}>Volgende →</Btn>
          </div>
        </div>
      )}

      {/* ══ FACTOR A ══════════════════════════════════════════════════════════ */}
      {step === "factorA" && (
        <div>
          <Progress step={vision === "early" ? 9 : 8} total={TOTAL} />
          <Q label="Wat is jouw Factor A?" sub="Dit is het bedrag dat je per jaar aan pensioen opbouwt via je werkgever. Je vindt het op je UPO.">
            <Tip>Staat op je jaarlijkse UPO bij "pensioenaangroei". Typisch €500–€8.000/jaar. <strong>Geen werkgeverspensioen? Vul 0 in.</strong></Tip>
            <Field value={factorA} onChange={setFactorA} placeholder="3000" />
            {factorA !== "" && (
              <div style={{ marginTop: 14, background: "#E1F5EE", border: "1.5px solid #1D9E75", borderRadius: "var(--border-radius-md)", padding: "14px 16px" }}>
                <p style={{ margin: "0 0 4px", fontSize: 13, color: "#0F6E56", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>Jouw Jaarruimte 2026</p>
                <p style={{ margin: "0 0 4px", fontSize: 28, fontWeight: 500, color: "#085041" }}>{fmtEur(jaarruimte(income, parseFloat(factorA) || 0))}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>per jaar</span></p>
                <p style={{ margin: "0 0 4px", fontSize: 13, color: "#0F6E56" }}>= {fmtM(Math.round(jaarruimte(income, parseFloat(factorA) || 0) / 12))} fiscaal aftrekbaar via lijfrente</p>
                <p style={{ margin: 0, fontSize: 12, color: "#0F6E56", opacity: 0.8 }}>30% × {fmtEur(Math.min(Math.max(0, income - AOW_FRANCHISE), MAX_GRONDSLAG))} − 6,27 × {fmtEur(parseFloat(factorA) || 0)}</p>
              </div>
            )}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => go("priority")}>← Terug</Btn>
            <Btn onClick={() => go("risk")} disabled={factorA === ""}>Volgende →</Btn>
            <Skip onClick={() => { setFactorA("0"); go("risk"); }}>Sla over</Skip>
          </div>
        </div>
      )}

      {/* ══ RISK ══════════════════════════════════════════════════════════════ */}
      {step === "risk" && (
        <div>
          <Progress step={vision === "early" ? 10 : 9} total={TOTAL} />
          <Q label="Hoe ga jij om met risico?" sub="Kies de uitspraak die het beste bij jou past. Er is geen goed of fout antwoord.">
            {[
              { label: "Ik wil zekerheid. Verlies is geen optie.",                         sub: "Defensief — verwacht rendement ~2,5%/jaar",    idx: 0 },
              { label: "Kleine schommelingen zijn prima, als het maar stabiel blijft.",     sub: "Gebalanceerd — verwacht rendement ~4,5%/jaar", idx: 1 },
              { label: "Ik accepteer flinke ups en downs voor hogere groei.",              sub: "Offensief — verwacht rendement ~6,5%/jaar",     idx: 2 },
              { label: "Ik ga voor maximale groei, ook als dat grote verliezen kan betekenen.", sub: "Zeer offensief — verwacht rendement ~9%/jaar", idx: 3 },
            ].map(o => <Choice key={o.idx} label={o.label} sub={o.sub} selected={riskChoice === o.idx} onClick={() => setRiskChoice(o.idx)} />)}
          </Q>
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => go("factorA")}>← Terug</Btn>
            <Btn onClick={() => { setConfirmedIdx(riskChoice); go("scenario"); }} disabled={riskChoice === null}>Zie mijn scenario →</Btn>
          </div>
        </div>
      )}

      {/* ══ SCENARIO ══════════════════════════════════════════════════════════ */}
      {step === "scenario" && (
        <div>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: 18, lineHeight: 1.6 }}>Op basis van jouw antwoorden stellen we dit profiel voor. Klopt dit voor jou?</p>
          <div style={{ background: profile.bg, border: `1.5px solid ${profile.border}`, borderRadius: "var(--border-radius-lg)", padding: "1.25rem", marginBottom: 16 }}>
            <span style={{ display: "inline-block", background: profile.color, color: "#fff", fontSize: 12, fontWeight: 500, padding: "3px 12px", borderRadius: 20, marginBottom: 10 }}>Voorgesteld profiel</span>
            <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 500, color: profile.text }}>{profile.label}</p>
            <p style={{ margin: 0, fontSize: 14, color: profile.text, opacity: 0.85, lineHeight: 1.6 }}>{profile.desc}</p>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem", marginBottom: 14 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Verwacht extra pensioeninkomen per maand</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {[["Pessimistisch", profile.pessimistic, "#E24B4A"], ["Verwacht", profile.expected, "#1D9E75"], ["Optimistisch", profile.optimistic, "#378ADD"]].map(([lbl, pct, col]) => {
                const pot = fv(alloc.pensionMonthly, pct, yearsToRetirement);
                const inc = Math.round(pmt(pot, pensionPayoutYears));
                return (
                  <div key={lbl} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--color-text-secondary)" }}>{lbl}</p>
                    <p style={{ margin: "0 0 2px", fontSize: 19, fontWeight: 500, color: col }}>{fmtM(inc)}</p>
                    <p style={{ margin: 0, fontSize: 11, color: "var(--color-text-tertiary)" }}>pot: {fmtEur(pot)}</p>
                  </div>
                );
              })}
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
              Bancaire lijfrente over {pensionPayoutYears} jaar à {annuityRate(pensionPayoutYears)}% (Rabobank feb 2026). Bruto — belasting van toepassing.
            </p>
          </div>

          <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 12 }}>Hoe voelt dit?</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn onClick={() => go("plan")}>Dit past bij mij ✓</Btn>
            {profileIdx < PROFILES.length - 1 && <Btn variant="ghost" onClick={() => { const n = profileIdx + 1; setRiskChoice(n); setConfirmedIdx(n); }}>Meer risico →</Btn>}
            {profileIdx > 0 && <Btn variant="ghost" onClick={() => { const n = profileIdx - 1; setRiskChoice(n); setConfirmedIdx(n); }}>← Minder risico</Btn>}
          </div>
        </div>
      )}

      {/* ══ PLAN (simple) ═════════════════════════════════════════════════════ */}
      {step === "plan_simple" && (
        <div>
          <div style={{ background: "#E1F5EE", border: "1.5px solid #1D9E75", borderRadius: "var(--border-radius-lg)", padding: "1.5rem", marginBottom: 20 }}>
            <span style={{ display: "inline-block", background: "#1D9E75", color: "#fff", fontSize: 12, fontWeight: 500, padding: "3px 12px", borderRadius: 20, marginBottom: 10 }}>Goed nieuws</span>
            <p style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 500, color: "#085041" }}>Je pensioen ziet er goed uit</p>
            <p style={{ margin: 0, fontSize: 15, color: "#085041", lineHeight: 1.65, opacity: 0.9 }}>Op basis van je situatie heb je voldoende opgebouwd. Je hoeft nu niets extra te doen.</p>
          </div>
          {pensionPots && pensionPots.map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
              <p style={{ margin: 0, fontSize: 14 }}>{p.naam}</p>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{fmtM(p.brutoMaand)}</p>
            </div>
          ))}
          <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.6, marginTop: 16, marginBottom: 16 }}>Ter oriëntatie — geen financieel advies.</p>
          <Btn variant="ghost" onClick={() => { setPensionFeeling("more"); go("gap"); }}>Toch meer opbouwen</Btn>
        </div>
      )}

      {/* ══ FULL PLAN ═════════════════════════════════════════════════════════ */}
      {step === "plan" && (
        <div>
          <span style={{ display: "inline-block", background: "#E1F5EE", color: "#085041", fontSize: 12, fontWeight: 500, padding: "4px 14px", borderRadius: 20, marginBottom: 16, letterSpacing: "0.04em" }}>Jouw persoonlijke pensioenplan</span>
          <h2 style={{ fontSize: 24, fontWeight: 500, margin: "0 0 6px" }}>Het complete overzicht</h2>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: "0 0 24px", lineHeight: 1.6 }}>Van nu tot na je pensioen — alles op een rij.</p>

          {/* Budget verdeling */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem", marginBottom: 14 }}>
            <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Jouw budgetverdeling · {fmtM(budgetN)} totaal</p>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-text-tertiary)" }}>Prioriteit: {priority === "bridge" ? "Eerder stoppen" : priority === "pension" ? "Extra pensioen" : "Gelijke verdeling"}</p>
            {vision === "early" && <BudgetBar label="Vrij beleggen — overbrugging" amount={alloc.bridgeMonthly} total={budgetN} color="#EF9F27" sub={`${earlyAge}–${AOW_AGE} jaar`} />}
            <BudgetBar label="Lijfrente — extra pensioen" amount={alloc.lijfrenteMonthly} total={budgetN} color="#1D9E75" sub="fiscaal aftrekbaar" />
            {alloc.vrijMonthly - alloc.bridgeMonthly > 0 && <BudgetBar label="Vrij beleggen — aanvullend" amount={alloc.vrijMonthly - alloc.bridgeMonthly} total={budgetN} color="#378ADD" sub="flexibel" />}
            {taxSaving > 0 && (
              <div style={{ marginTop: 12, padding: "10px 12px", background: "#E1F5EE", borderRadius: "var(--border-radius-md)" }}>
                <p style={{ margin: 0, fontSize: 13, color: "#085041" }}>💡 Belastingteruggave op lijfrente: <strong>{fmtEur(taxSaving)}/jaar</strong> — effectief kost je inleg maar {fmtM(Math.round(alloc.lijfrenteMonthly * (1 - TAX_RATE)))} netto.</p>
              </div>
            )}
          </div>

          {/* Overbrugging */}
          {vision === "early" && alloc.bridgeMonthly > 0 && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderLeft: "3px solid #EF9F27", borderRadius: "var(--border-radius-md)", padding: "1.25rem", marginBottom: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: "#854F0B", textTransform: "uppercase", letterSpacing: "0.06em" }}>Overbrugging · {earlyAge}–{AOW_AGE} jaar</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <StatCard label="Maandelijkse inleg" value={fmtM(alloc.bridgeMonthly)} />
                <StatCard label="Verwacht pot" value={fmtEur(Math.round(fv(alloc.bridgeMonthly, profile.expected, yearsToEarly)))} sub="bij vertrek" />
                <StatCard label="Dekt maandelijks" value={fmtM(Math.round(fv(alloc.bridgeMonthly, profile.expected, yearsToEarly) / (yearsToBridge * 12)))} sub={`over ${yearsToBridge} jaar`} />
              </div>
              <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--color-text-tertiary)" }}>Vrij beleggen — flexibel opneembaar, niet fiscaal aftrekbaar.</p>
            </div>
          )}

          {/* Extra pensioen */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderLeft: "3px solid #1D9E75", borderRadius: "var(--border-radius-md)", padding: "1.25rem", marginBottom: 14 }}>
            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: "#0F6E56", textTransform: "uppercase", letterSpacing: "0.06em" }}>Extra pensioenopbouw · tot {AOW_AGE} jaar · {profile.label}</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
              {[["Pessimistisch", profile.pessimistic, "#E24B4A"], ["Verwacht", profile.expected, "#1D9E75"], ["Optimistisch", profile.optimistic, "#378ADD"]].map(([lbl, pct, col]) => {
                const pot   = fv(alloc.pensionMonthly, pct, yearsToRetirement);
                const extra = Math.round(pmt(pot, pensionPayoutYears));
                const total = existingTotal + extra;
                return (
                  <div key={lbl} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--color-text-secondary)" }}>{lbl}</p>
                    {pensionPots && <p style={{ margin: "0 0 2px", fontSize: 11, color: "var(--color-text-tertiary)" }}>bestaand: {fmtM(existingTotal)}</p>}
                    <p style={{ margin: "0 0 2px", fontSize: 11, color: "var(--color-text-tertiary)" }}>extra: {fmtM(extra)}</p>
                    <p style={{ margin: 0, fontSize: 19, fontWeight: 500, color: col }}>{fmtM(pensionPots ? total : extra)}</p>
                  </div>
                );
              })}
            </div>
            {/* Lijfrente breakdown */}
            {alloc.lijfrenteMonthly > 0 && (() => {
              const lijfrentePot = fv(alloc.lijfrenteMonthly, profile.expected, yearsToRetirement);
              const lijfrenteIncome = Math.round(pmt(lijfrentePot, pensionPayoutYears));
              const lijfrentePotPess = fv(alloc.lijfrenteMonthly, profile.pessimistic, yearsToRetirement);
              const lijfrentePotOpt  = fv(alloc.lijfrenteMonthly, profile.optimistic,  yearsToRetirement);
              const lijfrenteIncPess = Math.round(pmt(lijfrentePotPess, pensionPayoutYears));
              const lijfrenteIncOpt  = Math.round(pmt(lijfrentePotOpt,  pensionPayoutYears));
              return (
                <div style={{ marginTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 14 }}>
                  <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: "#0F6E56", textTransform: "uppercase", letterSpacing: "0.05em" }}>Lijfrente uitkering</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <StatCard label="Maandelijkse inleg" value={fmtM(alloc.lijfrenteMonthly)} sub={`${fmtEur(alloc.lijfrenteMonthly * 12)}/jaar — fiscaal aftrekbaar`} accent="#E1F5EE" />
                    <StatCard label="Verwacht pot bij pensioen" value={fmtEur(Math.round(lijfrentePot))} sub={`na ${yearsToRetirement} jaar bij ${profile.expected}% rendement`} accent="#E1F5EE" />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <StatCard label="Belastingteruggave" value={fmtEur(taxSaving) + "/jaar"} sub={`effectieve netto inleg: ${fmtM(Math.round(alloc.lijfrenteMonthly * (1 - TAX_RATE)))}`} accent="#E1F5EE" />
                    <StatCard label="Netto inleg over looptijd" value={fmtEur(Math.round(alloc.lijfrenteMonthly * (1 - TAX_RATE) * 12 * yearsToRetirement))} sub={`na belastingteruggave`} accent="#E1F5EE" />
                  </div>
                  <div style={{ background: "#085041", borderRadius: "var(--border-radius-md)", padding: "14px 16px" }}>
                    <p style={{ margin: "0 0 4px", fontSize: 12, color: "#9FE1CB", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>Bruto maanduitkering uit lijfrente</p>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
                      <p style={{ margin: 0, fontSize: 28, fontWeight: 500, color: "#fff" }}>{fmtM(lijfrenteIncome)}</p>
                      <p style={{ margin: 0, fontSize: 13, color: "#9FE1CB" }}>pessimistisch: {fmtM(lijfrenteIncPess)} · optimistisch: {fmtM(lijfrenteIncOpt)}</p>
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "#5DCAA5", lineHeight: 1.5 }}>
                      Bancaire lijfrente over {pensionPayoutYears} jaar à {annuityRate(pensionPayoutYears)}% (Rabobank feb 2026). Bruto — belasting van toepassing bij uitkering.
                    </p>
                  </div>
                </div>
              );
            })()}

            <div style={{ marginTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 14 }}>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Vermogensverdeling</p>
              {Object.entries(profile.alloc).map(([lbl, pct], i) => (
                <AllocBar key={lbl} label={lbl} pct={pct} color={["#378ADD", "#1D9E75", "#EF9F27"][i]} />
              ))}
            </div>
          </div>

          {/* Bestaand pensioen */}
          {pensionPots && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderLeft: "3px solid #378ADD", borderRadius: "var(--border-radius-md)", padding: "1.25rem", marginBottom: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: "#185FA5", textTransform: "uppercase", letterSpacing: "0.06em" }}>Bestaand pensioen (mijnpensioenoverzicht.nl)</p>
              {pensionPots.map((p, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < pensionPots.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                  <div>
                    <p style={{ margin: "0 0 2px", fontSize: 14 }}>{p.naam}</p>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: (p.soort === "AOW" ? "#378ADD" : "#1D9E75") + "22", color: p.soort === "AOW" ? "#185FA5" : "#0F6E56", fontWeight: 500 }}>{p.soort}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 500, alignSelf: "center" }}>{fmtM(p.brutoMaand)}</p>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, marginTop: 4 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: "#185FA5" }}>Totaal opgebouwd</p>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "#185FA5" }}>{fmtM(existingTotal)}</p>
              </div>
            </div>
          )}

          {/* Total income summary */}
          {(() => {
            const lijfrentePot = fv(alloc.lijfrenteMonthly, profile.expected, yearsToRetirement);
            const lijfrentePotPess = fv(alloc.lijfrenteMonthly, profile.pessimistic, yearsToRetirement);
            const lijfrentePotOpt  = fv(alloc.lijfrenteMonthly, profile.optimistic,  yearsToRetirement);
            const lijfrenteInc     = Math.round(pmt(lijfrentePot,      pensionPayoutYears));
            const lijfrenteIncPess = Math.round(pmt(lijfrentePotPess,  pensionPayoutYears));
            const lijfrenteIncOpt  = Math.round(pmt(lijfrentePotOpt,   pensionPayoutYears));
            const totalExp  = existingTotal + lijfrenteInc;
            const totalPess = existingTotal + lijfrenteIncPess;
            const totalOpt  = existingTotal + lijfrenteIncOpt;
            const manualM = parseFloat(manualPension) || 0;
            const rows = [
              ...(pensionPots ? pensionPots.map(p => ({ label: p.naam, tag: p.soort, pess: p.brutoMaand, exp: p.brutoMaand, opt: p.brutoMaand, color: p.soort === "AOW" ? "#185FA5" : "#0F6E56" })) : []),
              ...(!pensionPots && manualM > 0 ? [{ label: "Huidig pensioen (handmatig opgegeven)", tag: "Inclusief AOW", pess: manualM, exp: manualM, opt: manualM, color: "#378ADD" }] : []),
              ...(alloc.lijfrenteMonthly > 0 ? [{ label: "Lijfrente uitkering", tag: "Nieuw · fiscaal aftrekbaar", pess: lijfrenteIncPess, exp: lijfrenteInc, opt: lijfrenteIncOpt, color: "#085041" }] : []),
            ];
            if (rows.length === 0) return null;
            return (
              <div style={{ background: "var(--color-background-primary)", border: "1.5px solid #1D9E75", borderRadius: "var(--border-radius-lg)", padding: "1.25rem", marginBottom: 14 }}>
                <p style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 500, color: "#0F6E56", textTransform: "uppercase", letterSpacing: "0.06em" }}>Totaal pensioeninkomen per maand · vanaf {AOW_AGE} jaar</p>
                <div style={{ marginBottom: 4 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                    <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }} />
                    <span style={{ fontSize: 11, color: "#E24B4A", fontWeight: 500, textAlign: "right" }}>Pessimist.</span>
                    <span style={{ fontSize: 11, color: "#1D9E75", fontWeight: 500, textAlign: "right" }}>Verwacht</span>
                    <span style={{ fontSize: 11, color: "#378ADD", fontWeight: 500, textAlign: "right" }}>Optimist.</span>
                  </div>
                  {rows.map((row, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", gap: 8, padding: "8px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", alignItems: "center" }}>
                      <div>
                        <p style={{ margin: "0 0 3px", fontSize: 14, color: "var(--color-text-primary)" }}>{row.label}</p>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: row.color + "22", color: row.color, fontWeight: 500 }}>{row.tag}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 500, textAlign: "right", color: "#E24B4A" }}>{fmtM(row.pess)}</p>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 500, textAlign: "right", color: "#1D9E75" }}>{fmtM(row.exp)}</p>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 500, textAlign: "right", color: "#378ADD" }}>{fmtM(row.opt)}</p>
                    </div>
                  ))}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", gap: 8, paddingTop: 10, marginTop: 2 }}>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: "#085041" }}>Totaal bruto</p>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 500, textAlign: "right", color: "#E24B4A" }}>{fmtM(totalPess)}</p>
                    <p style={{ margin: 0, fontSize: 17, fontWeight: 500, textAlign: "right", color: "#085041" }}>{fmtM(totalExp)}</p>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 500, textAlign: "right", color: "#378ADD" }}>{fmtM(totalOpt)}</p>
                  </div>
                  {desiredN > 0 && (
                    <div style={{ marginTop: 12, padding: "10px 12px", background: totalExp >= desiredN ? "#E1F5EE" : "#FAEEDA", borderRadius: "var(--border-radius-md)" }}>
                      <p style={{ margin: 0, fontSize: 13, color: totalExp >= desiredN ? "#085041" : "#633806", lineHeight: 1.6 }}>
                        {totalExp >= desiredN
                          ? `✓ Je verwachte inkomen van ${fmtM(totalExp)} dekt je streefbedrag van ${fmtM(desiredN)}.`
                          : `Je verwachte inkomen van ${fmtM(totalExp)} ligt ${fmtM(desiredN - totalExp)} onder je streefbedrag van ${fmtM(desiredN)}.`
                        }
                      </p>
                    </div>
                  )}
                </div>
                <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>Alle bedragen zijn bruto per maand. Over de lijfrente-uitkering betaal je inkomstenbelasting bij ontvangst.</p>
              </div>
            );
          })()}

          <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.6, marginBottom: 20 }}>
            Dit plan is ter oriëntatie en vormt geen financieel advies. Rendementen zijn niet gegarandeerd. Raadpleeg een gecertificeerd financieel adviseur voor een persoonlijk advies.
          </p>
          <Btn variant="ghost" onClick={() => { setStep("intro"); setVision(null); setCurrentAge(""); setGrossIncome(""); setPensionPots(null); setPensionFeeling(null); setDesiredTotal(""); setBudget(""); setPriority(null); setFactorA(""); setRiskChoice(null); setConfirmedIdx(null); setTermsAccepted(false); setManualPension(""); }}>Opnieuw beginnen</Btn>
        </div>
      )}

    </div>
  );
}
