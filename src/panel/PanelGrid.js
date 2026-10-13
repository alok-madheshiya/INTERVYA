// The video-call grid: one TalkingHead per interviewer, plus the candidate's
// own camera tile.
//
// Avatar supply is fixed and small. Ready Player Me shut down (models.readyplayer.me
// returns NXDOMAIN from the authoritative nameservers), so what remains is the
// GLBs vendored in public GitHub repos. TalkingHead needs an "Armature" root node
// plus Oculus visemes, which leaves exactly five usable avatars — verified with
// scripts/inspect-avatars.mjs. Only one of them reads as male, so panels lean
// female and the persona names follow the avatar rather than the other way round.

import { TalkingHead } from "talkinghead";

const GH = "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars";

/** avatar id -> { file, body }. `body` drives TalkingHead's idle pose. */
export const AVATARS = {
  daniel:   { file: "avatarsdk.glb",   body: "M" },
  meenakshi:{ file: "brunette.glb",    body: "F" },
  sneha:    { file: "mpfb.glb",        body: "F" },
  ananya:   { file: "avaturn.glb",     body: "F" },
};

const proxied = (u) => "/_asset?url=" + encodeURIComponent(u);

/**
 * Which office each seat is sitting in. Four CSS-painted rooms (see index.html)
 * dealt out in order so no two adjacent tiles share one — a panel where
 * everybody has the identical wall behind them reads as a rendering artefact,
 * not as a meeting.
 */
const ROOMS = ["a", "b", "c", "d"];

/**
 * Browser-first, then the main-process proxy (which caches to disk), then a
 * hand-placed file. The renderer's DNS works where Node's is flaky here, and the
 * proxy makes the second run offline.
 */
async function resolveAvatar(id, file) {
  const local = `/assets/avatars/${id}.glb`;
  if ((await fetch(local, { method: "HEAD" }).catch(() => null))?.ok) return local;

  const remote = `${GH}/${file}`;
  const direct = await fetch(remote).catch(() => null);
  if (direct?.ok) return URL.createObjectURL(await direct.blob());

  const viaProxy = await fetch(proxied(remote)).catch(() => null);
  if (viaProxy?.ok) return proxied(remote);

  throw new Error(`avatar ${file} could not be found in any source`);
}

export class PanelGrid {
  /** @param {HTMLElement} root @param {object[]} members persona objects */
  constructor(root, members) {
    this.root = root;
    this.members = members;
    this.tiles = new Map();   // id -> { member, head, el, visemes }
  }

  async mount(onProgress) {
    this.root.replaceChildren();

    // Panellists plus the candidate's own tile. A 2x2 for four people is what
    // a real call looks like; one row of letterboxes with dead space above and
    // below is not. Five people become 3 + 2, and the CSS centres the short row.
    const seatCount = this.members.length + 1;
    const cols = Math.ceil(Math.sqrt(seatCount));
    this.root.style.setProperty("--cols", cols);
    this.root.style.setProperty("--rows", Math.ceil(seatCount / cols));

    // Seats are built up front so the room is populated while the avatars are
    // still downloading — a call fills in one person at a time, and waiting on
    // a blank screen for all four does not.
    //
    // The elements stay in a local array rather than on the member objects:
    // the roster is sent over IPC every turn, and a DOM node cannot be cloned.
    const seats = this.members.map((m, i) => {
      const el = document.createElement("div");
      el.className = "tile";
      el.dataset.room = ROOMS[i % ROOMS.length];
      el.innerHTML =
        `<div class="room"></div>` +
        `<div class="head"></div>` +
        `<div class="tag"><b>${m.name}</b><span>${m.title}</span></div>`;
      this.root.appendChild(el);
      return el;
    });

    for (const [i, m] of this.members.entries()) {
      const el = seats[i];

      onProgress?.(m.name);
      try {
        const url = await resolveAvatar(m.avatarId, AVATARS[m.avatarId].file);
        const head = new TalkingHead(el.querySelector(".head"), {
          ttsEndpoint: null,          // audio comes from our own Speech class
          lipsyncModules: ["en"],
          cameraView: "upper",
          avatarMood: "neutral",
          modelPixelRatio: window.devicePixelRatio || 1,
        });
        await head.showAvatar({
          url,
          body: AVATARS[m.avatarId].body,
          avatarMood: "neutral",
          lipsyncLang: "en",
        });

        // Morph targets are split across meshes (head, teeth, eyes) and which
        // one carries the visemes differs per exporter — reading only morphs[0]
        // reports zero for avatars that actually have all fifteen.
        const names = new Set();
        for (const mo of head.morphs || []) {
          for (const k of Object.keys(mo.morphTargetDictionary || {})) names.add(k);
        }
        const visemes = [...names].filter((k) => k.startsWith("viseme_")).length;

        this.tiles.set(m.id, { member: m, head, el, visemes });
      } catch (e) {
        // One broken avatar must not take the panel down; the seat stays, just
        // without a face.
        el.querySelector(".head").innerHTML =
          `<div class="noface">${m.name.split(" ").map((w) => w[0]).join("")}</div>`;
        this.tiles.set(m.id, { member: m, head: null, el, visemes: 0 });
        console.warn("[panel] avatar failed:", m.name, e.message);
      }
    }
    return this.tiles;
  }

  /** Adds the candidate's own camera as the last tile. */
  addSelf(stream, name = "You") {
    const el = document.createElement("div");
    el.className = "tile self";
    el.innerHTML = `<video autoplay muted playsinline></video><div class="tag"><b>${name}</b></div>`;
    el.querySelector("video").srcObject = stream;
    this.root.appendChild(el);
    this.selfEl = el;
    return el;
  }

  /** Blue ring on whoever is talking, mirroring how Meet marks the speaker. */
  setSpeaking(id) {
    for (const [tid, t] of this.tiles) t.el.classList.toggle("speaking", tid === id);
    this.selfEl?.classList.toggle("speaking", id === "self");
  }

  /** Silent reactions the panel shows while someone else is talking. */
  react(id, cue) {
    const t = this.tiles.get(id);
    if (!t?.head) return;
    try {
      if (cue === "nod") t.head.playGesture?.("ok", 2);
      else if (cue === "frown") t.head.setMood?.("sad");
      else if (cue === "lean_in") t.head.playGesture?.("thumbup", 1);
      else if (cue === "note_taking") t.el.classList.add("noting");
      else if (cue === "check_time") t.el.classList.add("noting");
    } catch { /* gesture sets differ per avatar rig */ }
    if (cue === "note_taking" || cue === "check_time") {
      setTimeout(() => t.el.classList.remove("noting"), 2500);
    }
  }

  /** Head-tilt + a held pause while the candidate's answer is being processed. */
  setThinking(id, on) {
    const t = this.tiles.get(id);
    t?.el.classList.toggle("thinking", !!on);
  }

  dispose() {
    for (const t of this.tiles.values()) {
      try { t.head?.stop(); } catch { /* already stopped */ }
    }
    this.tiles.clear();
  }
}
