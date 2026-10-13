// Generates data/companies.json from compact declarations.
//
// Round structures are researched, not invented — every company carries a
// `verified_on` date so stale data is visible. Placement processes change every
// year; re-run this after re-checking sources.
//
//   node data/build-companies.mjs
//
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFIED = "2026-09-05";

// --- Round templates ------------------------------------------------------
// `type` selects the scoring rubric and the question-generation strategy.
// `must_do` are instructions handed to the panel prompt for that round.
const T = {
  oa: {
    name: "Online Assessment", type: "aptitude", minutes: 90, simulated: false,
    note: "The app does not simulate this — it happens on a coding platform.",
  },
  fundamentals: {
    name: "Technical — CS Fundamentals", type: "cs_fundamentals", minutes: 30,
    focus: ["oops", "dbms", "os", "cn", "sql", "one language deep"],
    must_do: [
      "Never accept a definition — immediately ask for an example, or where they used it in code",
      "Go two or three layers deep on one topic before moving to the next",
      "If it sounds memorised, go straight to an application question",
    ],
  },
  dsa: {
    name: "Technical — DSA", type: "dsa", minutes: 45,
    focus: ["arrays", "strings", "hashmaps", "trees", "recursion", "complexity"],
    must_do: [
      "Ask for the approach before any code — start with how they would think about it",
      "Once brute force arrives, ask them to optimise it; never hand over the solution",
      "Make them state both time and space complexity",
      "Raise one edge case they have missed",
    ],
  },
  lld: {
    name: "Machine Coding / Low-Level Design", type: "lld", minutes: 60,
    focus: ["class design", "SOLID", "extensibility", "edge cases"],
    must_do: [
      "Give the requirements deliberately incomplete — see whether they clarify or assume",
      "Once the design stands, add a new requirement and ask what it changes",
    ],
  },
  hld: {
    name: "System Design (fresher level)", type: "system_design", minutes: 45,
    focus: ["API design", "database choice", "caching", "scale basics"],
    must_do: ["Do not ask a fresher about distributed consensus — stay at practical scale"],
  },
  project: {
    name: "Project & Resume Deep-Dive", type: "project", minutes: 35,
    focus: ["ownership", "technical depth", "trade-offs", "honesty"],
    must_do: [
      "Pick the project at the top of the resume",
      "Not what was built — ask what THEY personally wrote",
      "Take one design choice and ask why that, and why not the alternative",
      "Ask what happens when it fails — push on the failure mode",
      "If the answers stay vague, say you are not convinced — politely, but plainly",
    ],
  },
  managerial: {
    name: "Managerial Round", type: "managerial", minutes: 30,
    focus: ["conflict", "deadlines", "teamwork", "learning ability", "relocation"],
    must_do: ["Check for STAR structure — ask for both the situation and the result"],
  },
  hr: {
    name: "HR Round", type: "hr", minutes: 20,
    focus: ["self intro", "strengths/weakness", "why this company", "goals", "salary", "bond"],
    must_do: [
      "Catch the rehearsed answer — everyone says that, ask for their own example",
      "Follow up on the weakness: what did they actually do about it?",
    ],
  },
  gd: {
    name: "Group Discussion", type: "gd", minutes: 15,
    focus: ["clarity", "listening", "assertiveness"],
    must_do: ["Have the other panelists raise counter-points so it becomes a real debate"],
  },
  case: {
    name: "Case / Guesstimate Round", type: "case", minutes: 30,
    focus: ["structuring", "assumptions", "arithmetic out loud"],
    must_do: ["If a number arrives without a stated assumption, stop them there"],
  },
  behavioral_lp: {
    name: "Hiring Manager — Behavioral", type: "hr", minutes: 45,
    focus: ["ownership", "dive deep", "bias for action", "deliver results"],
    must_do: [
      "On every answer, ask what specifically THEY did — move them off we and onto I",
      "Ask for the data: how much did it improve, in numbers",
    ],
  },
};

// r("dsa") or r("dsa", { minutes: 60, name: "..." })
const r = (key, over = {}) => ({ id: key, ...T[key], ...over });

// --- Personas -------------------------------------------------------------
// harshness 0-3. Every session forces at least one panelist at >= 2.
const PERSONAS = [
  { id: "p_tcs_senior", name: "Rakesh Iyer", title: "Senior Technical Lead", gender: "M", age: "45-50",
    harshness: 2, speciality: ["dbms", "sql", "oops"],
    tic: "Right, tell me one thing —", pet_peeve: "reciting a memorised definition",
    style: "Quiet, formal, writes a great many notes. Leaves long silences that make candidates nervous." },
  { id: "p_tcs_hr", name: "Meenakshi Rao", title: "HR Business Partner", gender: "F", age: "35-40",
    harshness: 1, speciality: ["communication", "culture fit"],
    tic: "Okay, so —", pet_peeve: "answers that sound rehearsed",
    style: "Warm, but assessing throughout. Digs behind every rehearsed answer for a real example." },
  { id: "p_infy_panel", name: "Srinivas Kumar", title: "Technology Analyst", gender: "M", age: "30-35",
    harshness: 2, speciality: ["java", "oops", "os"], tic: "Right, right.",
    pet_peeve: "buzzwords used without understanding",
    style: "Rapid-fire. An incomplete answer just gets the next question — no reassurance." },
  { id: "p_amazon_sde2", name: "Kabir Malhotra", title: "SDE II", gender: "M", age: "28-32",
    harshness: 3, speciality: ["dsa", "complexity", "edge cases"], tic: "Hmm. Okay.",
    pet_peeve: "writing code before thinking",
    style: "Looks friendly and lets nothing go. Drops a hint and watches whether it gets picked up. Never satisfied with brute force." },
  { id: "p_amazon_sdm", name: "Ananya Desai", title: "Software Development Manager", gender: "F", age: "38-42",
    harshness: 2, speciality: ["leadership principles", "ownership", "project depth"],
    tic: "Tell me more about that.", pet_peeve: "saying we when asked about I",
    style: "Digs every behavioral answer down to the data. Stops them the moment she hears we." },
  { id: "p_google_swe", name: "Rohan Verma", title: "Software Engineer III", gender: "M", age: "29-33",
    harshness: 2, speciality: ["dsa", "problem decomposition"], tic: "Interesting —",
    pet_peeve: "not asking a clarifying question",
    style: "Wants to hear the thinking out loud. If you go quiet he asks what you are thinking." },
  { id: "p_startup_founder", name: "Aditya Shetty", title: "Engineering Manager", gender: "M", age: "31-35",
    harshness: 3, speciality: ["project reality", "trade-offs", "shipping"],
    tic: "Wait, hold on —", pet_peeve: "claiming a tutorial project as your own",
    style: "Casual, fast, entirely unfiltered. Spots waffle instantly and says so." },
  { id: "p_startup_sde", name: "Nikita Bansal", title: "SDE II", gender: "F", age: "26-30",
    harshness: 2, speciality: ["lld", "clean code", "api design"], tic: "So basically —",
    pet_peeve: "building a God class",
    style: "Practical. Asks what the code will look like, not what the theory says." },
  { id: "p_gcc_vp", name: "Suresh Narayanan", title: "Vice President, Technology", gender: "M", age: "45-52",
    harshness: 2, speciality: ["fundamentals", "communication", "structured thinking"],
    tic: "Let me ask you this —", pet_peeve: "answering without structure",
    style: "Formal, senior, a little distant. Looking for clarity and maturity." },
  { id: "p_gcc_analyst", name: "Priya Menon", title: "Senior Associate", gender: "F", age: "27-31",
    harshness: 1, speciality: ["sql", "aptitude", "case structuring"], tic: "Got it.",
    pet_peeve: "quoting a number without stating the assumption",
    style: "Takes notes, says little, and every question is precise." },
  { id: "p_quiet_observer", name: "Vikram Joshi", title: "Principal Engineer", gender: "M", age: "40-45",
    harshness: 3, speciality: ["depth", "first principles"], tic: "",
    pet_peeve: "surface-level answer",
    style: "Speaks two or three times in a whole round — and it is always the hardest question in it." },
  { id: "p_friendly_junior", name: "Sneha Kulkarni", title: "SDE I", gender: "F", age: "24-27",
    harshness: 1, speciality: ["dsa basics", "projects"], tic: "Cool, cool.",
    pet_peeve: "over-confidence",
    style: "The newest panelist, and a warm one — but she catches a technical mistake instantly." },
];

// --- Roles and pay --------------------------------------------------------
// Entry-level tracks each company actually hires freshers into, with an
// approximate total CTC range in lakhs per annum.
//
// These are ranges, not offers. Campus and off-campus differ, tier and track
// differ, and the product-company numbers include stock that vests over years
// rather than cash in hand — which is why the UI labels them "approx" and says
// so out loud. They are here to make the choice concrete ("Ninja vs Prime is a
// different interview"), not to promise a number.
//
// Sourced from published campus-offer ranges and levels data as of the
// VERIFIED date above; re-check when re-checking the round structures.
const role = (title, min, max, note = "") => ({ title, ctc: [min, max], note });

// Per category, for the companies that do not need their own list.
const DEFAULT_ROLES = {
  service: [role("Systems Engineer", 3.5, 4.5), role("Software Engineer", 5, 7.5)],
  product: [role("SDE-1", 20, 34), role("Software Engineer", 18, 30)],
  startup: [role("SDE-1", 18, 30), role("Backend Engineer", 18, 30)],
  gcc: [role("Analyst", 8, 14), role("Software Engineer", 10, 18), role("Associate", 9, 15)],
};

// Named tracks matter here: at TCS or Cognizant the track decides which
// interview you sit, so it belongs in the picker rather than in a footnote.
const ROLES = {
  // ---- Service-based ----
  tcs: [
    role("Ninja", 3.36, 3.36, "The base NQT track"),
    role("Digital", 7, 7.5, "For a high NQT score"),
    role("Prime", 9, 11.5, "The top track, with its own interview"),
  ],
  infosys: [
    role("Systems Engineer", 3.6, 3.6),
    role("Digital Specialist Engineer", 6.25, 6.5, "Via InfyTQ or HackWithInfy"),
    role("Power Programmer", 9, 9.5, "HackWithInfy top rankers"),
  ],
  wipro: [
    role("Project Engineer", 3.5, 3.5, "Elite NTH"),
    role("Turbo / WILP track", 6.5, 7.5),
  ],
  accenture: [
    role("Associate Software Engineer", 4.5, 4.5),
    role("Advanced ASE", 6.5, 6.5, "On assessment score"),
  ],
  cognizant: [
    role("GenC", 4, 4.5),
    role("GenC Next", 6.5, 6.5),
    role("GenC Pro", 9, 9.5),
  ],
  capgemini: [role("Analyst", 4.25, 4.25), role("Senior Analyst", 7.5, 8)],
  hcltech: [role("Graduate Engineer Trainee", 4.25, 4.5), role("Software Engineer", 6, 7.5)],
  techmahindra: [role("Associate Software Engineer", 3.25, 4), role("Software Engineer", 5.5, 7)],
  ltimindtree: [role("Graduate Engineer Trainee", 4, 4.5), role("Senior Engineer", 6.5, 8)],
  mphasis: [role("Associate Software Engineer", 4, 4.5), role("Software Engineer", 6, 7.5)],

  // ---- Product ----
  amazon: [role("SDE-1", 26, 45, "Base + sign-on + RSU"), role("Support Engineer", 12, 18)],
  microsoft: [role("SDE", 40, 55, "Base + stock + bonus"), role("Support Engineer", 15, 22)],
  google: [role("Software Engineer L3", 45, 65, "Base + stock + bonus")],
  adobe: [role("MTS-1 (Member of Technical Staff)", 28, 40), role("Software Engineer", 22, 32)],
  atlassian: [role("Software Engineer", 30, 45)],
  salesforce: [role("Associate MTS", 25, 40)],
  oracle: [role("Application Engineer", 18, 28), role("Member of Technical Staff", 20, 30)],
  sap: [role("Associate Developer", 18, 28)],
  cisco: [role("Software Engineer I", 18, 28)],
  qualcomm: [role("Engineer (Software)", 20, 32), role("Engineer (Hardware/DSP)", 20, 32)],
  nvidia: [role("Software Engineer", 25, 40), role("System Software Engineer", 25, 42)],
  uber: [role("Software Engineer I", 35, 55)],
  flipkart: [role("SDE-1", 25, 38, "Base + ESOP")],
  walmart: [role("Software Engineer III", 25, 38)],
  phonepe: [role("SDE-1", 28, 42)],
  samsung: [role("Software Engineer (SRI-B/SRI-N)", 12, 22)],

  // ---- Startups / unicorns ----
  zomato: [role("SDE-1", 20, 32)],
  swiggy: [role("SDE-1", 20, 32)],
  razorpay: [role("SDE-1", 20, 32)],
  cred: [role("SDE-1", 28, 45)],
  zepto: [role("SDE-1", 20, 35)],
  groww: [role("SDE-1", 25, 40)],
  meesho: [role("SDE-1", 26, 40)],
  dream11: [role("SDE-1", 24, 38)],
  sharechat: [role("SDE-1", 22, 35)],
  rapido: [role("SDE-1", 15, 25)],
  physicswallah: [role("SDE-1", 12, 22)],

  // ---- GCC / consulting ----
  deloitte: [role("Analyst", 6.5, 9), role("Consultant", 9, 13)],
  ey: [role("Analyst", 6, 9), role("Senior Analyst", 9, 12)],
  pwc: [role("Associate", 6.5, 9.5), role("Senior Associate", 10, 14)],
  kpmg: [role("Analyst", 6, 9), role("Consultant", 9, 12)],
  jpmc: [role("Software Engineer I", 18, 27, "CIB / Corporate Technology")],
  goldman: [role("Analyst — Engineering", 20, 32)],
  morganstanley: [role("Technology Analyst", 18, 28)],
  optum: [role("Software Engineer", 10, 16), role("Data Analyst", 9, 14)],
  zs: [role("Business Technology Solutions Associate", 12, 18),
       role("Decision Analytics Associate", 12, 18)],
  barclays: [role("Technology Analyst", 15, 24)],
  amex: [role("Engineer I", 16, 26), role("Analyst", 14, 22)],
};

// --- Companies ------------------------------------------------------------
const service = (id, name, extra = {}) => ({
  id, name, category: "service", difficulty: 2,
  panel_style: "Formal and a little dry. Rapid-fire on CS fundamentals, with heavy weight on communication.",
  interviewer_titles: ["Technical Lead", "Project Manager", "HR"],
  persona_pool: ["p_tcs_senior", "p_infy_panel", "p_tcs_hr", "p_gcc_vp"],
  rounds: [r("oa"), r("fundamentals"), r("project"), r("hr")],
  ...extra,
});

const product = (id, name, extra = {}) => ({
  id, name, category: "product", difficulty: 4,
  panel_style: "Friendly, and they let nothing go. They drop hints and watch whether you pick them up.",
  interviewer_titles: ["SDE II", "Senior SDE", "Engineering Manager"],
  persona_pool: ["p_amazon_sde2", "p_google_swe", "p_quiet_observer", "p_friendly_junior"],
  rounds: [r("oa"), r("dsa"), r("dsa", { id: "dsa2", name: "Technical 2 — DSA" }), r("project")],
  ...extra,
});

const startup = (id, name, extra = {}) => ({
  id, name, category: "startup", difficulty: 4,
  panel_style: "Casual and fast, but very sharp. They spot waffle instantly and say so.",
  interviewer_titles: ["SDE II", "Engineering Manager", "Tech Lead"],
  persona_pool: ["p_startup_founder", "p_startup_sde", "p_friendly_junior"],
  rounds: [r("oa"), r("dsa"), r("lld"), r("project", { name: "Hiring Manager — Project + Culture" })],
  ...extra,
});

const gcc = (id, name, extra = {}) => ({
  id, name, category: "gcc", difficulty: 3,
  panel_style: "A formal panel. Structured thinking and communication carry as much weight as the tech.",
  interviewer_titles: ["Vice President", "Senior Associate", "HR"],
  persona_pool: ["p_gcc_vp", "p_gcc_analyst", "p_tcs_hr", "p_quiet_observer"],
  rounds: [r("oa"), r("fundamentals"), r("project"), r("hr")],
  ...extra,
});

const COMPANIES = [
  // ---- Service-based ----
  service("tcs", "TCS", {
    difficulty: 2,
    rounds: [
      r("oa", { name: "TCS NQT (Aptitude + Coding)" }),
      r("fundamentals", { name: "Technical Interview", minutes: 35,
        must_do: [...T.fundamentals.must_do, "Have them write code on paper once — pseudo-code is fine"] }),
      r("project"),
      r("managerial", { name: "Managerial Round (MR)" }),
      r("hr", { focus: [...T.hr.focus, "service agreement / bond", "relocation anywhere in India"] }),
    ],
    signature_behaviour: "Makes you write code in the tech round, and in HR confirms your commitment to the bond and to being posted anywhere.",
    notes: "NQT cycle-based hiring on the TCS iON platform. The Ninja, Digital and Prime tracks are decided by NQT score.",
  }),
  service("infosys", "Infosys", {
    rounds: [r("oa", { name: "InfyTQ / HackWithInfy Assessment" }), r("fundamentals"), r("project"), r("hr")],
    signature_behaviour: "Picks one language off your resume and goes deep in it — you wrote Java, so the questions will be in Java.",
    notes: "For tier-2 and tier-3 colleges, InfyTQ certification and HackWithInfy matter more than CGPA.",
  }),
  service("wipro", "Wipro", {
    rounds: [r("oa", { name: "Elite NTH Assessment" }), r("gd"), r("fundamentals"), r("project"), r("hr")],
    signature_behaviour: "Some campus drives include a group discussion, where you have to make your own opening to speak.",
    notes: "Elite National Talent Hunt. Not every drive includes a group discussion.",
  }),
  service("accenture", "Accenture", {
    difficulty: 3,
    rounds: [r("oa", { name: "Cognitive + Technical Assessment (game-based)" }),
             r("fundamentals"), r("project"), r("hr", { name: "HR + Communication Assessment" })],
    signature_behaviour: "There is a separate communication assessment — English fluency is judged explicitly.",
    notes: "ASE vs Advanced ASE tracks. 6-stage process with game-based cognitive test.",
  }),
  service("cognizant", "Cognizant", {
    signature_behaviour: "GenC, GenC Next and GenC Pro tracks — your assessment score decides which one you land in.",
  }),
  service("capgemini", "Capgemini", {
    rounds: [r("oa", { name: "Game-based Aptitude + Technical" }),
             r("fundamentals"), r("project"), r("hr")],
    signature_behaviour: "There is an essay-writing round — written English is checked explicitly.",
  }),
  service("hcltech", "HCLTech", { signature_behaviour: "Fresher hiring asks how flexible you are about domain — infrastructure versus development." }),
  service("techmahindra", "Tech Mahindra", { signature_behaviour: "Extra weight on the communication round, and the telecom domain comes up." }),
  service("ltimindtree", "LTIMindtree", { difficulty: 3, signature_behaviour: "The coding round is on the tougher side — DSA basics come up too." }),
  service("mphasis", "Mphasis", {}),

  // ---- Product-based ----
  product("amazon", "Amazon", {
    difficulty: 5,
    rounds: [
      r("oa", { name: "Online Assessment (2 DSA + Work Style + Work Simulation)" }),
      r("dsa", { name: "Technical 1 — DSA",
        must_do: [...T.dsa.must_do, "Slip one Leadership Principle behavioral question into the middle of the round"] }),
      r("dsa", { id: "dsa2", name: "Technical 2 — DSA + Design-lite",
        must_do: [...T.dsa.must_do, "Add a small design angle: how would this run for a million users"] }),
      r("behavioral_lp", { name: "Hiring Manager — Project + Leadership Principles" }),
    ],
    signature_behaviour: "EVERY round carries at least one Leadership Principle behavioral question — that is the Amazon signature. Say we and they stop you on the spot.",
    notes: "16 Leadership Principles. There may also be a Bar Raiser round. Fresher CTC is around 18-26 LPA.",
  }),
  product("microsoft", "Microsoft", {
    difficulty: 5,
    rounds: [r("oa"), r("dsa"), r("dsa", { id: "dsa2", name: "Technical 2 — DSA + Design" }),
             r("project", { name: "AA Round — Project + Culture Fit" })],
    signature_behaviour: "The As Appropriate (AA) round is taken by someone senior, and focuses on culture and growth mindset.",
  }),
  product("google", "Google", {
    difficulty: 5,
    rounds: [r("oa"), r("dsa", { minutes: 45 }), r("dsa", { id: "dsa2", name: "Technical 2 — DSA" }),
             r("project", { name: "Googleyness & Leadership" })],
    signature_behaviour: "Sitting in silence is not an option — the interviewer keeps asking what you are thinking. The process matters more than the solution.",
  }),
  product("adobe", "Adobe", { difficulty: 4,
    signature_behaviour: "CS fundamentals and DSA in equal measure — OS and DBMS come up despite it being a product company.",
    rounds: [r("oa"), r("dsa"), r("fundamentals", { minutes: 40 }), r("project")] }),
  product("atlassian", "Atlassian", { difficulty: 4,
    rounds: [r("oa"), r("dsa"), r("lld"), r("project", { name: "Values Round" })],
    signature_behaviour: "There is a separate values round, with direct questions on Atlassian's five values." }),
  product("salesforce", "Salesforce", { difficulty: 4 }),
  product("oracle", "Oracle", { difficulty: 4,
    rounds: [r("oa"), r("dsa"), r("fundamentals", { focus: ["dbms", "sql", "os", "oops"] }), r("project")],
    signature_behaviour: "An unusual amount of focus on DBMS and SQL — normalisation, indexing, query optimisation." }),
  product("sap", "SAP", { difficulty: 3 }),
  product("cisco", "Cisco", { difficulty: 4,
    rounds: [r("oa"), r("dsa"), r("fundamentals", { focus: ["cn", "os", "tcp/ip", "oops"] }), r("project")],
    signature_behaviour: "They go very deep on computer networks — TCP handshake, routing, subnetting." }),
  product("qualcomm", "Qualcomm", { difficulty: 4,
    signature_behaviour: "Focused on C and embedded/OS concepts — pointers, memory, bit manipulation." }),
  product("nvidia", "Nvidia", { difficulty: 5 }),
  product("uber", "Uber", { difficulty: 5, rounds: [r("oa"), r("dsa"), r("dsa", { id: "dsa2" }), r("hld"), r("project")] }),
  product("flipkart", "Flipkart", { difficulty: 4,
    rounds: [r("oa"), r("dsa"), r("lld", { name: "Machine Coding Round" }), r("project", { name: "Hiring Manager Round" })],
    signature_behaviour: "The machine coding round wants running code in 60-90 minutes — the design and the working code both." }),
  product("walmart", "Walmart Global Tech", { difficulty: 4 }),
  product("phonepe", "PhonePe", { difficulty: 4,
    rounds: [r("oa"), r("dsa"), r("lld"), r("project", { name: "Hiring Manager Round" })] }),
  product("samsung", "Samsung R&D", { difficulty: 4,
    rounds: [r("oa", { name: "Samsung Online Test (3 hr, 1 hard problem)" }), r("dsa"), r("fundamentals"), r("hr")],
    signature_behaviour: "The online test is one very hard problem in three hours — a real test of DSA depth." }),

  // ---- Startups / unicorns ----
  startup("zomato", "Zomato", { difficulty: 4,
    rounds: [r("oa", { name: "Online Coding Assessment (2-3 DSA + debugging)", minutes: 105 }),
             r("dsa"), r("hld", { name: "Technical 2 — Backend + Design" }),
             r("managerial", { name: "Managerial / Culture Fit" }), r("hr")],
    signature_behaviour: "The managerial round decides it — people are cut here even after the tech went fine." }),
  startup("swiggy", "Swiggy", { difficulty: 4,
    signature_behaviour: "They take you to real logistics and scale problems — how would you assign a delivery partner." }),
  startup("razorpay", "Razorpay", { difficulty: 4,
    rounds: [r("oa", { name: "Online Coding Assessment (DSA)" }), r("dsa"),
             r("lld", { name: "Low-Level Design Round" }), r("project", { name: "Hiring Manager Round" })],
    signature_behaviour: "The LLD round is the heaviest — 30-40% of your prep belongs there. They ask about payment-domain edge cases." }),
  startup("cred", "CRED", { difficulty: 5,
    signature_behaviour: "Obsessed with design taste and code quality — would you really ship this code to production?" }),
  startup("zepto", "Zepto", { difficulty: 4,
    signature_behaviour: "Obsessed with speed — how would you do this in ten minutes, about everything." }),
  startup("groww", "Groww", { difficulty: 4 }),
  startup("meesho", "Meesho", { difficulty: 4 }),
  startup("dream11", "Dream11", { difficulty: 4,
    signature_behaviour: "Questions about scale — what if ten million users arrive at once during a match?" }),
  startup("sharechat", "ShareChat", { difficulty: 4 }),
  startup("rapido", "Rapido", { difficulty: 3 }),
  startup("physicswallah", "Physics Wallah", { difficulty: 3 }),

  // ---- GCC / mass recruiters ----
  gcc("deloitte", "Deloitte", { rounds: [r("oa"), r("fundamentals"), r("case"), r("hr")],
    signature_behaviour: "A consulting flavour — alongside the technical, they ask how you would explain it to a client." }),
  gcc("ey", "EY", { rounds: [r("oa"), r("fundamentals"), r("case"), r("hr")] }),
  gcc("pwc", "PwC", { rounds: [r("oa"), r("fundamentals"), r("case"), r("hr")] }),
  gcc("kpmg", "KPMG", { rounds: [r("oa"), r("fundamentals"), r("case"), r("hr")] }),
  gcc("jpmc", "JPMorgan Chase", { difficulty: 4,
    rounds: [r("oa", { name: "HireVue Video Assessment + Coding" }), r("dsa"),
             r("fundamentals"), r("hr", { name: "Behavioral / Fit" })],
    signature_behaviour: "There is a one-way HireVue video round — you speak to a camera alone, with no reaction coming back.",
    notes: "Two or three technical rounds. Graphs, DP and system design basics are common." }),
  gcc("goldman", "Goldman Sachs", { difficulty: 5,
    rounds: [r("oa", { name: "HackerRank Online Test" }), r("dsa"),
             r("dsa", { id: "dsa2", name: "Technical 2 — DSA + Maths" }), r("hr", { name: "VP Round" })],
    signature_behaviour: "Probability and maths puzzles arrive alongside the DSA. Every round is an elimination.",
    notes: "Three elimination rounds is typical, with calls alongside a VP and serving engineers." }),
  gcc("morganstanley", "Morgan Stanley", { difficulty: 4 }),
  gcc("optum", "Optum / UnitedHealth", { difficulty: 3 }),
  gcc("zs", "ZS Associates", { difficulty: 3,
    rounds: [r("oa"), r("case", { name: "Guesstimate / Case Round", minutes: 35 }),
             r("fundamentals", { focus: ["sql", "excel logic", "python basics"] }), r("hr")],
    signature_behaviour: "The guesstimate round is the core of it — how many auto-rickshaws are there in Delhi. Structure matters more than the answer." }),
  gcc("barclays", "Barclays", { difficulty: 3 }),
  gcc("amex", "American Express", { difficulty: 3 }),
];

// --- Emit -----------------------------------------------------------------
const out = {
  verified_on: VERIFIED,
  round_types: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.type])),
  personas: PERSONAS,
  salary_note:
    "Approximate total CTC in lakhs per annum. It varies with campus versus off-campus, " +
    "with college tier and with track. Product-company figures include stock, which vests over years.",
  companies: COMPANIES.map((c) => ({
    signature_behaviour: "",
    notes: "",
    verified_on: VERIFIED,
    ...c,
    roles: ROLES[c.id] ?? DEFAULT_ROLES[c.category],
  })),
};

writeFileSync(path.join(here, "companies.json"), JSON.stringify(out, null, 2) + "\n");
console.log(
  `companies.json: ${out.companies.length} companies, ${PERSONAS.length} personas` +
  `\n  service=${COMPANIES.filter((c) => c.category === "service").length}` +
  ` product=${COMPANIES.filter((c) => c.category === "product").length}` +
  ` startup=${COMPANIES.filter((c) => c.category === "startup").length}` +
  ` gcc=${COMPANIES.filter((c) => c.category === "gcc").length}`
);
