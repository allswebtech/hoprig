// What the stand-in Claude Code answers to Work's "Plan with AI" (src/work/proposal.mjs firstMessage): a proposal in
// the shape that message asks for, made from the goal, the project and the day the message names. A goal that holds
// "no plan" gets an answer without one; "hidden" gets a title with a character that cannot be seen; "many" gets 61
// tasks.
export function planAnswer(text) {
  const lines = text.split('\n');
  const goal = lines[3] || 'a goal';
  const project = (/^The project is ([^:]+): this folder\./m.exec(text) || [])[1] || 'shop';
  const today = (/Today is (\d{4}-\d{2}-\d{2})\./.exec(text) || [])[1] || '2026-11-18';
  const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  if (/no plan/i.test(goal)) return 'I looked, and I would rather not plan this.';
  const tasks = /many/i.test(goal)
    ? Array.from({ length: 61 }, (_, i) => ({ title: `Step number ${i + 1}`, date: null, milestone: null, by: 'ai', after: [], brief: null, check: null }))
    : [
      { title: 'Measure the home page', date: day(1), milestone: 1, by: 'ai', after: [], brief: `Measure how long the home page of ${project} takes to load, and write the numbers down.`, check: 'A table of load times.' },
      { title: 'Make the images small', date: day(3), milestone: 1, by: 'ai', after: [1], brief: 'Turn the large images into small WebP files; change nothing else.', check: 'No image over 200 KB.' },
      { title: 'Review the smaller images', date: day(6), milestone: 2, by: 'reviewer', after: [2], brief: 'Look at each new image next to the old one.', check: 'Each image looks right.' },
      { title: 'Say yes to the new home page', date: day(8), milestone: 2, by: 'me', after: [3], brief: null, check: 'You said yes.' },
    ];
  const plan = {
    title: /hidden/i.test(goal) ? 'Make the site​ faster' : `Plan: ${goal}`.slice(0, 120),
    goal: 'The home page loads in under two seconds on a phone.',
    projects: [project],
    note: `## What exists\n- The project ${project} has a home page (\`index.html\`).\n- Big images are the usual cause (https://web.dev/fast/), assumed here.\n\n## Open questions\n- Which phone counts?`,
    milestones: [{ title: 'Measured and smaller', date: day(4) }, { title: 'Approved', date: day(8) }],
    tasks,
  };
  return `I read the project and planned it.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}
