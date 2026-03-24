import pc from "picocolors";

const TAGLINE = "Open-source orchestration for zero-human companies";

export function printHiveCliBanner(): void {
  const lines = [
    "",
    pc.cyan("  ██╗  ██╗██╗██╗   ██╗███████╗"),
    pc.cyan("  ██║  ██║██║██║   ██║██╔════╝"),
    pc.cyan("  ███████║██║██║   ██║█████╗  "),
    pc.cyan("  ██╔══██║██║╚██╗ ██╔╝██╔══╝  "),
    pc.cyan("  ██║  ██║██║ ╚████╔╝ ███████╗"),
    pc.cyan("  ╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝"),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
