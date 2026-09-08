<script setup lang="ts">
// The request flow, animated: a message reaches the dispatcher, the dispatcher
// hands it to an agent, the agent runs its tools through an executor (twice,
// here — a tool call and its result each way), and the outcome is a pull
// request. One ten-second CSS loop drives every part from the same clock:
// each step lights when the signal reaches it, the dot rides the link between
// steps, and the agent holds an amber "thinking" ring while its tools run.
//
// Under `prefers-reduced-motion: reduce` nothing moves and the flow rests at
// its legible end frame — every step lit, the arrows in place, no dot — which
// is also what the diagram looks like on a page that cannot animate.
//
// The steps are plain text in a list, so the flow reads in order without the
// styling; the connectors are decoration and hidden from assistive technology.
const steps = [
  {
    name: "Message",
    detail: "Slack · CLI · HTTP · MCP",
    icon: "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z",
  },
  {
    name: "Dispatcher",
    detail: "directive · config · authorization",
    icon: "M3 12h5m0 0 3.5-5H18m-7.5 5 3.5 5H18M18 7l-2.5-2.5M18 7l-2.5 2.5M18 17l-2.5-2.5M18 17l-2.5 2.5",
  },
  {
    name: "Agent",
    detail: "coding · review · ship · research · general",
    icon: "M12 3v3m0 12v3M3 12h3m12 0h3M7.5 7.5A6.4 6.4 0 0 1 12 5.6a6.4 6.4 0 1 1-4.5 1.9zM9.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0z",
  },
  {
    name: "Executor",
    detail: "local · sandbox · resident",
    icon: "M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM7 9l3 3-3 3m5 0h5",
  },
  {
    name: "Pull request",
    detail: "opened, linked in the thread",
    icon: "M6 4a2 2 0 1 0 0 4 2 2 0 1 0 0-4zm0 4v8m0 0a2 2 0 1 0 0 4 2 2 0 1 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 1 0 0-4zm0 0V9a3 3 0 0 0-3-3h-3m0 0 2.5-2.5M12 6l2.5 2.5",
  },
];
</script>

<template>
  <figure
    class="flow"
    aria-label="How a request flows: a message from a channel reaches the dispatcher, which routes it to an agent; the agent runs its tools through an executor and the outcome is a reply or a pull request."
  >
    <ol class="steps">
      <li v-for="(step, i) in steps" :key="step.name" class="step" :class="`s${i + 1}`">
        <div class="card">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="step.icon" />
          </svg>
          <span class="name">{{ step.name }}</span>
          <span class="detail">{{ step.detail }}</span>
        </div>
        <span v-if="i < steps.length - 1" class="link" :class="`l${i + 1}`" aria-hidden="true">
          <i class="dot"></i>
        </span>
      </li>
    </ol>
  </figure>
</template>

<style scoped>
.flow {
  margin: 0;
  --period: 10s;
  --dot: 10px;
  --link: 56px;
  --travel: calc(var(--link) - var(--dot));
}

.steps {
  display: flex;
  align-items: stretch;
  list-style: none;
  margin: 0;
  padding: 0;
}

.step {
  display: flex;
  align-items: stretch;
  flex: 1 1 0;
  min-width: 0;
}

.step:last-child {
  flex: 0 1 auto;
}

.card {
  flex: 1 1 0;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  align-content: start;
  column-gap: 10px;
  row-gap: 2px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-2);
  animation: var(--period) infinite;
  animation-delay: var(--at);
}

.icon {
  grid-row: 1 / span 2;
  align-self: start;
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.name {
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.detail {
  font-size: 12.5px;
  line-height: 1.35;
}

/* The link between two steps: a line, an arrowhead, and the dot that rides it. */
.link {
  position: relative;
  align-self: center;
  flex: 0 0 var(--link);
  height: 2px;
  background: var(--vp-c-divider);
}

.link::after {
  content: "";
  position: absolute;
  right: -1px;
  top: -4px;
  border: 5px solid transparent;
  border-left: 7px solid var(--vp-c-border);
  border-right: 0;
}

/* The executor's link points both ways: a call goes out, its result comes back. */
.l3::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -4px;
  border: 5px solid transparent;
  border-right: 7px solid var(--vp-c-border);
  border-left: 0;
}

.dot {
  position: absolute;
  top: calc(var(--dot) / -2 + 1px);
  left: 0;
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  background: var(--vp-c-brand-3);
  opacity: 0;
  animation: var(--period) infinite;
  animation-delay: var(--at);
}

/*
 * The clock. Every animation runs on the same ten-second period and starts at
 * its own moment (--at); everything fades together at 9.6s so the next pass
 * begins from dark. Read left to right:
 *
 *   0.0  message lights           0.8–1.6  the dot rides to the dispatcher
 *   1.6  dispatcher lights        2.2–3.0  rides to the agent
 *   3.0  agent starts thinking    3.8–4.4  a tool call goes to the executor
 *   4.4  executor lights          4.8–5.4  the result comes back
 *                                 5.8–6.4  a second call · 6.8–7.4 its result
 *   8.0  agent done               8.0–8.8  rides to the pull request
 *   8.8  pull request lands       9.6      fade
 *
 * A keyframe percentage cannot be a variable, so a step that lights at --at
 * and fades at 9.6s has its own keyframes with the fade at (9.6 − --at) / 10.
 */
.s1 .card {
  --at: 0s;
  animation-name: lit-until-96;
}
.l1 .dot {
  --at: 0.8s;
  animation-name: ride;
}
.s2 .card {
  --at: 1.6s;
  animation-name: lit-until-80;
}
.l2 .dot {
  --at: 2.2s;
  animation-name: ride;
}
.s3 .card {
  --at: 3s;
  animation-name: think;
}
.l3 .dot {
  --at: 3.8s;
  animation-name: exchange;
}
.s4 .card {
  --at: 4.4s;
  animation-name: lit-until-52;
}
.l4 .dot {
  --at: 8s;
  animation-name: ride;
}
.s5 .card {
  --at: 8.8s;
  animation-name: lit-until-8;
}

@keyframes lit-until-96 {
  0%,
  95% {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
  }
  96%,
  100% {
    border-color: var(--vp-c-divider);
    background: var(--vp-c-bg-elv);
    color: var(--vp-c-text-2);
  }
}

@keyframes lit-until-80 {
  0%,
  79% {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
  }
  80%,
  100% {
    border-color: var(--vp-c-divider);
    background: var(--vp-c-bg-elv);
    color: var(--vp-c-text-2);
  }
}

@keyframes lit-until-52 {
  0%,
  51% {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
  }
  52%,
  100% {
    border-color: var(--vp-c-divider);
    background: var(--vp-c-bg-elv);
    color: var(--vp-c-text-2);
  }
}

@keyframes lit-until-8 {
  0%,
  7% {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
  }
  8%,
  100% {
    border-color: var(--vp-c-divider);
    background: var(--vp-c-bg-elv);
    color: var(--vp-c-text-2);
  }
}

/* The agent thinks — an amber ring, breathing — from 3.0s until its tools are
 * done at 8.0s (50% of its cycle), holds green, and fades with the rest at 66%. */
@keyframes think {
  0%,
  50% {
    border-color: var(--sb-c-accent);
    background: var(--sb-c-accent-soft);
    color: var(--vp-c-text-1);
    box-shadow: 0 0 0 0 var(--sb-c-accent-soft);
  }
  8%,
  24%,
  40% {
    box-shadow: 0 0 0 6px var(--sb-c-accent-soft);
  }
  16%,
  32%,
  48% {
    box-shadow: 0 0 0 0 var(--sb-c-accent-soft);
  }
  52%,
  65% {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
    box-shadow: 0 0 0 0 transparent;
  }
  66%,
  100% {
    border-color: var(--vp-c-divider);
    background: var(--vp-c-bg-elv);
    color: var(--vp-c-text-2);
    box-shadow: 0 0 0 0 transparent;
  }
}

/* The dot appears, crosses the link in 0.8s (8% of the period), and is gone. */
@keyframes ride {
  0% {
    opacity: 1;
    transform: translateX(0);
  }
  8% {
    opacity: 1;
    transform: translateX(var(--travel));
  }
  8.01%,
  100% {
    opacity: 0;
    transform: translateX(0);
  }
}

/* Agent ↔ executor: out (a tool call) and back (its result), twice — out at
 * 0% and 20% of the period from the first call, back at 10% and 30%. */
@keyframes exchange {
  0% {
    opacity: 1;
    transform: translateX(0);
  }
  6% {
    opacity: 1;
    transform: translateX(var(--travel));
  }
  6.01%,
  9.99% {
    opacity: 0;
    transform: translateX(var(--travel));
  }
  10% {
    opacity: 1;
    transform: translateX(var(--travel));
  }
  16% {
    opacity: 1;
    transform: translateX(0);
  }
  16.01%,
  19.99% {
    opacity: 0;
    transform: translateX(0);
  }
  20% {
    opacity: 1;
    transform: translateX(0);
  }
  26% {
    opacity: 1;
    transform: translateX(var(--travel));
  }
  26.01%,
  29.99% {
    opacity: 0;
    transform: translateX(var(--travel));
  }
  30% {
    opacity: 1;
    transform: translateX(var(--travel));
  }
  36% {
    opacity: 1;
    transform: translateX(0);
  }
  36.01%,
  100% {
    opacity: 0;
    transform: translateX(0);
  }
}

/* Narrow screens: the same flow, top to bottom. The link stands upright and
 * the dot rides down it: the same keyframes, along Y. */
@media (max-width: 767px) {
  .steps,
  .step {
    flex-direction: column;
    align-items: stretch;
  }

  .link {
    align-self: center;
    width: 2px;
    height: var(--link);
    flex: 0 0 var(--link);
  }

  .link::after {
    right: auto;
    top: auto;
    left: -4px;
    bottom: -1px;
    border: 5px solid transparent;
    border-top: 7px solid var(--vp-c-border);
    border-bottom: 0;
  }

  .l3::before {
    left: -4px;
    top: -1px;
    border: 5px solid transparent;
    border-bottom: 7px solid var(--vp-c-border);
    border-top: 0;
  }

  .dot {
    top: 0;
    left: calc(var(--dot) / -2 + 1px);
  }

  @keyframes ride {
    0% {
      opacity: 1;
      transform: translateY(0);
    }
    8% {
      opacity: 1;
      transform: translateY(var(--travel));
    }
    8.01%,
    100% {
      opacity: 0;
      transform: translateY(0);
    }
  }

  @keyframes exchange {
    0% {
      opacity: 1;
      transform: translateY(0);
    }
    6% {
      opacity: 1;
      transform: translateY(var(--travel));
    }
    6.01%,
    9.99% {
      opacity: 0;
      transform: translateY(var(--travel));
    }
    10% {
      opacity: 1;
      transform: translateY(var(--travel));
    }
    16% {
      opacity: 1;
      transform: translateY(0);
    }
    16.01%,
    19.99% {
      opacity: 0;
      transform: translateY(0);
    }
    20% {
      opacity: 1;
      transform: translateY(0);
    }
    26% {
      opacity: 1;
      transform: translateY(var(--travel));
    }
    26.01%,
    29.99% {
      opacity: 0;
      transform: translateY(var(--travel));
    }
    30% {
      opacity: 1;
      transform: translateY(var(--travel));
    }
    36% {
      opacity: 1;
      transform: translateY(0);
    }
    36.01%,
    100% {
      opacity: 0;
      transform: translateY(0);
    }
  }
}

/* No motion: the end frame, lit and still. */
@media (prefers-reduced-motion: reduce) {
  .card,
  .dot {
    animation: none;
  }

  .card {
    border-color: var(--vp-c-brand-3);
    background: var(--vp-c-brand-soft);
    color: var(--vp-c-text-1);
  }

  .dot {
    display: none;
  }
}
</style>
