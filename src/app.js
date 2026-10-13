// App entry. Its most important job runs in the first few milliseconds:
// starting the TTS warm-up before anything is drawn, so the 86-121 s WebGPU
// session build overlaps with the candidate filling in the setup form instead
// of being a wait they sit through.

import { Speech, VOICES } from "./audio/tts.js";
import { SetupScreen } from "./screens/setup.js";
import { CallScreen } from "./screens/call.js";
import { ReportScreen } from "./screens/report.js";
import { TalkScreen } from "./screens/talk.js";
import { playIntro, trackPointer, trackCardGlow, buildBackdrop } from "./ui/ambience.js";

const screens = ["setup", "lobby", "call", "talk", "report"];
export function show(name) {
  for (const s of screens) {
    document.getElementById(s).classList.toggle("active", s === name);
  }
}

async function main() {
  // Ambience first: the opening plays while everything below is loading, and
  // the pointer trackers cost nothing to install.
  buildBackdrop();
  trackPointer();
  trackCardGlow();
  const intro = playIntro();

  // A single AudioContext is shared by TTS, the avatars and the mic meter.
  // Browsers start it suspended until a gesture; the setup screen provides one.
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const resume = () => audioCtx.resume().catch(() => {});
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });

  const usedVoices = [...VOICES.M, ...VOICES.F];
  const speech = new Speech(audioCtx, usedVoices);

  // Fire and forget — the setup screen polls `speech.state` for progress and
  // gates its Join button on it. A failure surfaces there, not as a dead app.
  speech.warmUp()
    .then(() => speech.primeFillers(usedVoices))
    .catch((e) => console.error("[tts] warm-up failed:", e));

  const [data, logoManifest, config] = await Promise.all([
    fetch("/data/companies.json").then((r) => r.json()),
    // Built once by data/build-logos.mjs. Missing entries fall back to a
    // monogram, so a stale or absent manifest degrades rather than breaks.
    fetch("/data/logos.json").then((r) => r.json()).catch(() => ({ logos: {} })),
    window.agent.config.get(),
  ]);
  data.logos = logoManifest.logos ?? {};

  window.__agent = { audioCtx, speech, data, config };

  // Boot probe: proves the data loaded and the screen actually rendered, so a
  // headless run can tell "started fine" from "white page, no error".
  console.log(
    `[app] boot ok — ${data.companies.length} companies, ${data.personas.length} personas, ` +
    `key=${config.active?.id ?? false}, encryption=${config.encryptionAvailable}`
  );

  // The main process is holding a timer against this call — without it, it
  // assumes the renderer died on the way up and says so. See watchForBoot.
  window.agent.booted?.();

  new SetupScreen({
    data,
    config,
    speech,
    onJoin: async (choice) => {
      window.__agent.choice = choice;

      // Talk mode is a different screen, not a different interview. It shares
      // the avatars, the voice and the mic, and nothing else.
      if (choice.mode === "talk") {
        console.log("[app] talking to", choice.character.name);
        const talk = new TalkScreen({
          choice, speech,
          // Leaving a conversation goes back to setup rather than to a report:
          // there is nothing to grade, and reloading would throw away the
          // warmed-up TTS session the app spent two minutes building.
          onLeave: () => show("setup"),
        });
        window.__agent.talk = talk;
        try {
          await talk.start(show);
        } catch (e) {
          console.error("[talk] failed:", e);
          document.getElementById("lobby").innerHTML =
            `<div class="lobbyWrap"><div class="lobbyCard">` +
            `<div class="lobbyCo">The call could not start</div>` +
            `<div class="sub" style="max-width:520px">${e.message}</div></div></div>`;
        }
        return;
      }

      console.log("[app] joining", choice.company.name, choice.round.name);

      const call = new CallScreen({
        choice, speech, data,
        onFinished: (session) => {
          console.log("[app] interview finished —", session.ledger.length, "ledger entries");
          call.stop();
          show("report");
          new ReportScreen(document.getElementById("report")).render(session, {
            onAgain: () => location.reload(),
          });
        },
      });
      window.__agent.call = call;

      try {
        await call.start(show);
      } catch (e) {
        console.error("[call] failed:", e);
        document.getElementById("lobby").innerHTML =
          `<div class="lobbyWrap"><div class="lobbyCard">` +
          `<div class="lobbyCo">The call could not start</div>` +
          `<div class="sub" style="max-width:520px">${e.message}</div></div></div>`;
      }
    },
  });

  // Built behind the overlay, so when the intro lifts the form is already
  // there and its entrance animations — held paused until now — play as the
  // reveal. The intro covers the load; it never becomes the load.
  await intro;

  const count = (sel) => document.querySelectorAll(sel).length;
  console.log(
    `[app] rendered — ${count("#companies .co")} companies, ${count("#roles .role")} role tracks, ` +
    `${count("#round option")} rounds, ${count("#chars .char")} characters, mode=` +
    document.getElementById("setup").dataset.mode
  );
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="padding:20px;color:#f85149">The app failed to start: ${e.message}</div>`
  );
});
