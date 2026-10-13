// Who the panelists *are* — face, name, gender, voice.
//
// Kept separate from personas on purpose. A persona says how someone behaves
// (harsh, pedantic, quiet until it matters); an identity says who the candidate
// sees and hears. Binding a name to a persona and then handing it whatever
// avatar came next is what produced male names on female faces.
//
// The face is the fixed point: only five avatars load in TalkingHead (Ready
// Player Me is gone — see scripts/inspect-avatars.mjs), and exactly one of them
// reads as male. So the identity is written to match the model, and behaviour is
// layered on top.

export const IDENTITIES = [
  {
    id: "daniel", avatar: "avatarsdk.glb", body: "M", voice: "hm_omega",
    // Western-looking model, so a Western name. Indian MNC panels routinely
    // include a visiting or global engineer, which this reads as.
    name: "Daniel Cole",
    // `role` and `vibe` are only used outside the interview, in Talk mode,
    // where there is no panel to hide behind and the character has to be
    // someone specific rather than a face with a harshness dial.
    role: "Senior engineer, ten years in",
    vibe: "Quiet and direct. Thinks before he answers, and says plainly when he " +
          "does not know something. System design and trade-offs are his ground.",
    good_for: ["System design", "Big career decisions", "Code-review style talk"],
  },
  {
    id: "meenakshi", avatar: "brunette.glb", body: "F", voice: "hf_alpha",
    name: "Meenakshi Rao",
    role: "Engineering Manager",
    vibe: "Practical, and blunt with it. No patience for talking around a thing — " +
          "she asks what the real question is, then gets to work on it.",
    good_for: ["Interview prep", "Salary and offers", "How teams actually work"],
  },
  {
    id: "ananya", avatar: "avaturn.glb", body: "F", voice: "hf_beta",
    name: "Ananya Desai",
    role: "SDE II, graduated two years ago",
    vibe: "Talks to you like a friend. She went through placements recently enough " +
          "to remember the nerves and the rejections, and she does not pretend otherwise.",
    good_for: ["Placement stress", "Where to start with DSA", "Whether you are on track"],
  },
  {
    id: "sneha", avatar: "mpfb.glb", body: "F", voice: "hf_alpha",
    name: "Sneha Kulkarni",
    role: "SDE I, first job",
    vibe: "Curious and quick. Asks questions back so you end up doing the thinking, " +
          "and tells you straight when something you said is wrong.",
    good_for: ["Understanding a concept", "Practising out loud", "Project ideas"],
  },
];

// Deliberately NOT here: brunette-t.glb. It is the same character as
// brunette.glb (the "-t" suffix is just a T-pose export), and two identical
// faces on one call is more obviously fake than a smaller panel.
// That caps the panel at four, which is a normal panel size anyway.

/** Titles that fit the round being simulated, most senior first. */
const TITLES = {
  dsa: ["Senior SDE", "SDE II", "Engineering Manager", "Principal Engineer"],
  lld: ["Engineering Manager", "SDE II", "Senior SDE", "Tech Lead"],
  system_design: ["Principal Engineer", "Engineering Manager", "Senior SDE", "Tech Lead"],
  cs_fundamentals: ["Senior Technical Lead", "Technology Analyst", "Project Manager", "Technical Lead"],
  project: ["Engineering Manager", "Senior Technical Lead", "Tech Lead", "SDE II"],
  managerial: ["Delivery Manager", "Project Manager", "Senior Manager", "Technical Lead"],
  hr: ["HR Business Partner", "Talent Acquisition Lead", "Senior Manager", "HR Manager"],
  case: ["Engagement Manager", "Senior Associate", "Principal", "Consultant"],
  gd: ["HR Business Partner", "Senior Manager", "Technical Lead", "Consultant"],
  aptitude: ["Senior Manager", "Technical Lead", "HR Business Partner", "Consultant"],
};

/**
 * Builds the panel the candidate actually meets: real faces with matching names
 * and voices, each carrying one persona's behaviour.
 *
 * @param {object[]} personas  behaviour cards chosen for this session
 * @param {string} roundType   selects plausible job titles
 * @param {() => number} rnd   seeded RNG, so a session is reproducible
 */
export function castPanel(personas, roundType, rnd = Math.random) {
  const titles = TITLES[roundType] ?? TITLES.project;

  // Shuffle the faces so the same company does not always open with the same
  // person, but keep the male identity available rather than always first.
  const faces = [...IDENTITIES];
  for (let i = faces.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [faces[i], faces[j]] = [faces[j], faces[i]];
  }

  return personas.slice(0, faces.length).map((p, i) => {
    const face = faces[i];
    return {
      // `id` must be the identity, not the persona: the model refers to the
      // speaker by this id and the panel grid looks tiles up by it.
      id: face.id,
      name: face.name,
      title: titles[i % titles.length],
      body: face.body,
      voice: face.voice,
      avatarId: face.id,

      // Behaviour comes from the persona; its name and title are discarded.
      harshness: p.harshness,
      speciality: p.speciality,
      pet_peeve: p.pet_peeve,
      tic: p.tic,
      style: p.style,
      personaId: p.id,
    };
  });
}
