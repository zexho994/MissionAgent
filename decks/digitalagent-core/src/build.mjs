import fs from "node:fs/promises";
import path from "node:path";
import {
  Presentation,
  PresentationFile,
  row,
  column,
  grid,
  layers,
  panel,
  text,
  shape,
  rule,
  fill,
  hug,
  fixed,
  wrap,
  grow,
  fr,
  auto,
} from "@oai/artifact-tool";

const OUT = path.resolve("output");
const SCRATCH = path.resolve("scratch");
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(SCRATCH, { recursive: true });

const W = 1920;
const H = 1080;

const C = {
  ink: "#172033",
  muted: "#5B667A",
  faint: "#E8EDF3",
  paper: "#F7F4EE",
  cream: "#FFFDF8",
  blue: "#2E5EAA",
  teal: "#1B8A7A",
  red: "#C8473D",
  gold: "#C88B2A",
};

const titleStyle = {
  fontFamily: "PingFang SC",
  fontSize: 68,
  bold: true,
  color: C.ink,
};

const subtitleStyle = {
  fontFamily: "PingFang SC",
  fontSize: 31,
  color: C.muted,
};

const bodyStyle = {
  fontFamily: "PingFang SC",
  fontSize: 34,
  color: C.ink,
};

const smallStyle = {
  fontFamily: "PingFang SC",
  fontSize: 24,
  color: C.muted,
};

async function saveBlob(blob, filePath) {
  if (typeof blob.save === "function") {
    await blob.save(filePath);
    return;
  }
  const buffer = Buffer.from(await blob.arrayBuffer());
  await fs.writeFile(filePath, buffer);
}

function addSlide(p, build) {
  const slide = p.slides.add();
  build(slide);
  return slide;
}

function compose(slide, node) {
  slide.compose(node, {
    frame: { left: 0, top: 0, width: W, height: H },
    baseUnit: 8,
  });
}

function base(children, opts = {}) {
  return layers(
    { name: "slide-layers", width: fill, height: fill },
    [
      shape({
        name: "background",
        width: fill,
        height: fill,
        fill: opts.bg ?? C.cream,
        line: { fill: opts.bg ?? C.cream, width: 0 },
      }),
      ...(opts.accent
        ? [
            shape({
              name: "accent-band",
              width: fixed(22),
              height: fill,
              fill: opts.accent,
              line: { fill: opts.accent, width: 0 },
            }),
          ]
        : []),
      column(
        {
          name: "content",
          width: fill,
          height: fill,
          padding: { x: 112, y: 84 },
          gap: opts.gap ?? 36,
        },
        children,
      ),
    ],
  );
}

function spacer(name = "spacer") {
  return shape({
    name,
    width: fill,
    height: grow(1),
    fill: "transparent",
    line: { fill: "transparent", width: 0 },
  });
}

function heading(title, subtitle) {
  return column({ name: "heading", width: fill, height: hug, gap: 18 }, [
    text(title, {
      name: "slide-title",
      width: wrap(1420),
      height: hug,
      style: titleStyle,
    }),
    subtitle
      ? text(subtitle, {
          name: "slide-subtitle",
          width: wrap(1320),
          height: hug,
          style: subtitleStyle,
        })
      : rule({ name: "title-rule", width: fixed(260), stroke: C.blue, weight: 5 }),
  ].filter(Boolean));
}

function lineItem(label, desc, color = C.blue) {
  return row({ name: `line-${label}`, width: fill, height: hug, gap: 22, align: "start" }, [
    shape({
      name: `mark-${label}`,
      width: fixed(14),
      height: fixed(46),
      fill: color,
      line: { fill: color, width: 0 },
      borderRadius: "rounded-full",
    }),
    column({ name: `copy-${label}`, width: fill, height: hug, gap: 8 }, [
      text(label, {
        name: `label-${label}`,
        width: fill,
        height: hug,
        style: { ...bodyStyle, bold: true },
      }),
      text(desc, {
        name: `desc-${label}`,
        width: wrap(1280),
        height: hug,
        style: smallStyle,
      }),
    ]),
  ]);
}

function nodeBox(name, detail, color) {
  return panel(
    {
      name: `node-${name}`,
      width: fill,
      height: hug,
      padding: { x: 30, y: 24 },
      borderRadius: "rounded-lg",
      fill: "#FFFFFF",
      line: { fill: color, width: 3 },
    },
    column({ name: `node-copy-${name}`, width: fill, height: hug, gap: 8 }, [
      text(name, {
        name: `node-title-${name}`,
        width: fill,
        height: hug,
        style: { ...bodyStyle, fontSize: 30, bold: true, color },
      }),
      text(detail, {
        name: `node-detail-${name}`,
        width: fill,
        height: hug,
        style: { ...smallStyle, fontSize: 21 },
      }),
    ]),
  );
}

const p = Presentation.create({
  slideSize: { width: W, height: H },
});

addSlide(p, (slide) => {
  compose(
    slide,
    base(
      [
        spacer("cover-top-space"),
        text("DigitalAgent", {
          name: "cover-kicker",
          width: fill,
          height: hug,
          style: { ...smallStyle, fontSize: 28, color: C.blue, bold: true },
        }),
        text("动态组队的 Agent 系统", {
          name: "cover-title",
          width: wrap(1180),
          height: hug,
          style: { ...titleStyle, fontSize: 84 },
        }),
        text("核心共识：我们做自己的大脑，用 OpenClaw 执行外部动作，参考 Edict 的组织方式。", {
          name: "cover-subtitle",
          width: wrap(1260),
          height: hug,
          style: { ...subtitleStyle, fontSize: 34 },
        }),
        spacer("cover-bottom-space"),
        text("简版设计说明 · 2026-04-27", {
          name: "cover-date",
          width: fill,
          height: hug,
          style: { ...smallStyle, fontSize: 22 },
        }),
      ],
      { bg: C.paper, accent: C.blue, gap: 24 },
    ),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base(
      [
        heading("一句话定义", "不是固定流程机器人，而是会为每个目标临时组队的协作系统。"),
        spacer("definition-top-space"),
        text("用户给出目标，系统任命负责人。负责人判断团队结构，HR 创建 subagents。团队持续产出、审核、复盘、调整。", {
          name: "definition",
          width: wrap(1420),
          height: hug,
          style: { ...bodyStyle, fontSize: 45, lineSpacing: 1.2 },
        }),
        spacer("definition-bottom-space"),
      ],
      { accent: C.teal },
    ),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base([
      heading("三个边界", "边界清楚，系统才不会越做越乱。"),
      spacer("boundary-top-space"),
      lineItem("DigitalAgent Core 是大脑", "负责目标、团队、任务、记忆、审核、复盘。", C.blue),
      lineItem("OpenClaw 是执行器", "负责浏览器、小红书页面、数据采集、外部工具动作。", C.teal),
      lineItem("Edict 是参考，不是底座", "学习它的组织思路，但不把我们的产品绑在它的代码里。", C.gold),
      spacer("boundary-bottom-space"),
    ]),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base([
      heading("核心对象", "先把系统骨架设计清楚，再写代码。"),
      grid(
        {
          name: "model-grid",
          width: fill,
          height: fill,
          columns: [fr(1), fr(1), fr(1)],
          rows: [auto, auto],
          columnGap: 28,
          rowGap: 28,
        },
        [
          nodeBox("Mission", "目标、约束、成功标准", C.blue),
          nodeBox("OwnerAgent", "负责人，决定怎么组队", C.teal),
          nodeBox("HRAgent", "按岗位说明创建 subagents", C.gold),
          nodeBox("RoleSpec", "职责、权限、输入输出", C.red),
          nodeBox("TaskGraph", "任务、依赖、状态流转", C.blue),
          nodeBox("Artifact / Review", "产物、证据、审核结论", C.teal),
        ],
      ),
    ]),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base([
      heading("Agent类型", "固定的是组织机制，动态的是业务角色。"),
      spacer("agent-types-top-space"),
      lineItem("Meta Agents", "Owner、HR、Supervisor、Scheduler。负责组织，不负责具体业务。", C.blue),
      lineItem("Business Agents", "由负责人按任务动态创建，例如选题、文案、数据、风控。", C.teal),
      lineItem("Execution Agents", "在 OpenClaw 中执行浏览器和外部动作，是临时执行容器。", C.gold),
      spacer("agent-types-bottom-space"),
    ]),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base([
      heading("如何连接 OpenClaw", "Core 只发送结构化任务，不把决策权交出去。"),
      spacer("openclaw-top-space"),
      grid(
        {
          name: "flow-grid",
          width: fill,
          height: hug,
          columns: [fr(1), fixed(110), fr(1), fixed(110), fr(1)],
          rows: [auto],
          columnGap: 16,
          align: "center",
        },
        [
          nodeBox("Core", "生成任务 payload", C.blue),
          text("→", { name: "arrow-1", width: fill, height: hug, style: { ...titleStyle, fontSize: 58, color: C.muted } }),
          nodeBox("OpenClaw Runner", "调用浏览器和工具", C.teal),
          text("→", { name: "arrow-2", width: fill, height: hug, style: { ...titleStyle, fontSize: 58, color: C.muted } }),
          nodeBox("Artifact", "结果、证据、错误回传", C.gold),
        ],
      ),
      spacer("openclaw-bottom-space"),
      text("关键点：OpenClaw 可以创建 subagent 执行任务，但 DigitalAgent 的 AgentInstance 才是业务角色。", {
        name: "boundary-note",
        width: wrap(1320),
        height: hug,
        style: { ...subtitleStyle, fontSize: 30 },
      }),
    ]),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base([
      heading("第一版只验证闭环", "不要一开始追求 24 小时完全自治。"),
      spacer("mvp-top-space"),
      grid(
        {
          name: "mvp-grid",
          width: fill,
          height: hug,
          columns: [fr(1), fr(1), fr(1)],
          rows: [auto],
          columnGap: 34,
        },
        [
          nodeBox("会组队", "Owner 能判断需要哪些角色，HR 能创建 subagents。", C.blue),
          nodeBox("会执行", "任务能交给 OpenClaw，拿回结构化产物。", C.teal),
          nodeBox("会复盘", "审核后能生成下一轮任务，而不是一次性回答。", C.gold),
        ],
      ),
      spacer("mvp-bottom-space"),
      text("小红书增长是第一条业务线：从目标、选题、内容、审核、采集、复盘开始。", {
        name: "mvp-note",
        width: wrap(1320),
        height: hug,
        style: { ...subtitleStyle, fontSize: 31 },
      }),
    ]),
  );
});

addSlide(p, (slide) => {
  compose(
    slide,
    base(
      [
        heading("现在的决定", "先做一个小而完整的系统，不做空泛平台。"),
        spacer("decision-top-space"),
        text("路线：自建 DigitalAgent Core，参考 Edict 的协作思想，通过 OpenClaw 插件执行外部动作。", {
          name: "decision",
          width: wrap(1400),
          height: hug,
          style: { ...bodyStyle, fontSize: 48, bold: true, lineSpacing: 1.15 },
        }),
        rule({ name: "decision-rule", width: fixed(420), stroke: C.teal, weight: 5 }),
        text("下一步：写 Mission / Team / Agent Runtime 的简版设计文档，然后进入 MVP 实现。", {
          name: "next-step",
          width: wrap(1260),
          height: hug,
          style: { ...subtitleStyle, fontSize: 32 },
        }),
        spacer("decision-bottom-space"),
      ],
      { bg: C.paper, accent: C.teal },
    ),
  );
});

const pptx = await PresentationFile.exportPptx(p);
await saveBlob(pptx, path.join(OUT, "output.pptx"));

const previews = [];
for (let i = 0; i < p.slides.count; i += 1) {
  const slide = p.slides.getItem(i);
  const png = await slide.export({ format: "png" });
  const file = path.join(SCRATCH, `slide-${String(i + 1).padStart(2, "0")}.png`);
  await saveBlob(png, file);
  previews.push(file);
}

await fs.writeFile(
  path.join(SCRATCH, "preview-manifest.json"),
  `${JSON.stringify({ pptx: path.join(OUT, "output.pptx"), previews }, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({ pptx: path.join(OUT, "output.pptx"), previews }, null, 2));
