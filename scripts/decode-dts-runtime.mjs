import vm from "node:vm";

const runtimeUrl = "https://assets.diantoushi.com/v3/tb_detail/tb_detail.js?entry=thlhz3";
const source = await (await fetch(runtimeUrl)).text();
const bootstrapEnd = source.indexOf(",!function");
const context = {};
vm.runInNewContext(`${source.slice(0, bootstrapEnd)});`, context, { timeout: 5_000 });

const aliases = new Set(["a0_0x35bd"]);
for (const match of source.matchAll(/(?:const|let|var)\s+([$_a-zA-Z0-9]+)=a0_0x35bd/g)) aliases.add(match[1]);

let decoded = source;
for (const alias of aliases) {
  const escaped = alias.replace(/[$]/g, "\\$");
  decoded = decoded.replace(new RegExp(`${escaped}\\((0x[0-9a-f]+)\\)`, "gi"), (_, rawIndex) => JSON.stringify(context.a0_0x35bd(Number(rawIndex))));
}

const terms = process.argv.slice(2);
for (const term of terms) {
  let offset = 0;
  let count = 0;
  while (count < 8) {
    const index = decoded.indexOf(term, offset);
    if (index < 0) break;
    console.log(`\n--- ${term} #${count + 1} @${index} ---\n${decoded.slice(Math.max(0, index - 800), index + term.length + 1600)}`);
    offset = index + term.length;
    count += 1;
  }
}
