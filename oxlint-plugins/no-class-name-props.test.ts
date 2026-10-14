import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-class-name-props.ts", import.meta.url));

describe("ds-policy/no-class-name-props", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-class-name-props-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    excludeFiles: ["packages/ds/src/components/ui/**"],
    files: ["packages/ds/src/components/**/*.{ts,tsx}"],
    rules: { "ds-policy/no-class-name-props": "error" },
  }],
};\n`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const writeFixture = async (relativePath: string, source: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  };

  const runOxlint = (paths: readonly string[]) => {
    const result = spawnSync(
      oxlint,
      [...paths, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports declared class-name props once per prop", async () => {
    await writeFixture(
      "packages/ds/src/components/card.tsx",
      `interface CardProps {
  className?: string;
  headerClassName?: string;
  title?: string;
}
export const Card = ({ className, headerClassName, title }: CardProps) => (
  <section className={className}>
    <header className={headerClassName}>{title}</header>
  </section>
);\n`,
    );

    const result = runOxlint(["packages/ds/src/components/card.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/ds-policy\(no-class-name-props\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Do not declare the 'className' prop/u);
    assert.match(result.output, /Do not declare the 'headerClassName' prop/u);
  });

  it("reports class names inherited from ComponentProps and destructured params", async () => {
    await writeFixture(
      "packages/ds/src/components/drop-area.tsx",
      `interface DropAreaProps extends Omit<React.ComponentProps<"div">, "onDrop" | "title"> {
  onFiles: (files: readonly File[]) => void;
}
export const DropArea = ({ className, onFiles, ...props }: DropAreaProps) => (
  <div className={className} {...props} />
);\n`,
    );
    await writeFixture(
      "packages/ds/src/components/pass-through.tsx",
      `import type { ComponentProps } from "react";
export const GroupText = (props: ComponentProps<"button">) => <button {...props} />;\n`,
    );
    await writeFixture(
      "packages/ds/src/components/heritage.tsx",
      `import type { HTMLAttributes } from "react";
interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
}
export const Box = ({ label, ...props }: BoxProps) => <div {...props}>{label}</div>;\n`,
    );

    const result = runOxlint([
      "packages/ds/src/components/drop-area.tsx",
      "packages/ds/src/components/pass-through.tsx",
      "packages/ds/src/components/heritage.tsx",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/ds-policy\(no-class-name-props\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /'HTMLAttributes' includes the 'className' prop/u);
    assert.match(result.output, /Do not accept the 'className' prop/u);
    assert.match(result.output, /'ComponentProps' includes the 'className' prop/u);
  });

  it("reports declared and destructured classNames props", async () => {
    await writeFixture(
      "packages/ds/src/components/calendar-field.tsx",
      `interface CalendarFieldProps {
  classNames?: Record<string, string>;
  dayClassNames?: Record<string, string>;
}
export const CalendarField = ({ classNames, dayClassNames }: CalendarFieldProps) => (
  <div data-day={dayClassNames} data-root={classNames} />
);
`,
    );

    const result = runOxlint(["packages/ds/src/components/calendar-field.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/ds-policy\(no-class-name-props\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Do not declare the 'classNames' prop/u);
    assert.match(result.output, /Do not declare the 'dayClassNames' prop/u);
  });

  it("allows ui primitives, Omit of className, Pick without it and indexed access", async () => {
    await writeFixture(
      "packages/ds/src/components/ui/button.tsx",
      `export const Button = ({ className }: { className?: string }) => (
  <button className={className} />
);\n`,
    );
    await writeFixture(
      "packages/ds/src/components/omitted.tsx",
      `import type { ComponentProps } from "react";
interface FieldProps extends Omit<ComponentProps<"div">, "className" | "style"> {
  label: string;
}
export const Field = ({ label, ...props }: FieldProps) => <div {...props}>{label}</div>;\n`,
    );
    await writeFixture(
      "packages/ds/src/components/picked.tsx",
      `import type { ComponentProps } from "react";
type AriaSort = ComponentProps<"th">["aria-sort"];
type CellProps = Pick<ComponentProps<"td">, "colSpan" | "children">;
export const Cell = ({ children, colSpan }: CellProps & { sort?: AriaSort }) => (
  <td colSpan={colSpan}>{children}</td>
);\n`,
    );
    await writeFixture(
      "apps/web/src/outside.tsx",
      `export const Panel = ({ className }: { className?: string }) => <div className={className} />;\n`,
    );

    const result = runOxlint([
      "packages/ds/src/components/ui/button.tsx",
      "packages/ds/src/components/omitted.tsx",
      "packages/ds/src/components/picked.tsx",
      "apps/web/src/outside.tsx",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});

describe("ds-policy/no-class-name-props on class names passed by app code", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-class-name-props-passed-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "ds-policy/no-class-name-props": "error" },
};\n`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const writeFixture = async (relativePath: string, source: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  };

  const runOxlint = (paths: readonly string[]) => {
    const result = spawnSync(
      oxlint,
      [...paths, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports class names passed through an object option or a classNames attribute", async () => {
    await writeFixture(
      "apps/web/src/draft-save.ts",
      `declare const toast: (message: string, options: object) => void;
toast("Bozza salvata", {
  classNames: { actionButton: "h-auto bg-transparent p-0" },
  className: "shadow-none",
});\n`,
    );
    await writeFixture(
      "apps/web/src/picker.tsx",
      `declare const DayPicker: (props: object) => null;
export const Picker = () => (
  <DayPicker classNames={{ day: "size-8" }} overlayClassName="z-50" />
);\n`,
    );

    const result = runOxlint(["apps/web/src/draft-save.ts", "apps/web/src/picker.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/ds-policy\(no-class-name-props\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /Do not pass class names through 'classNames'/u);
    assert.match(result.output, /Do not pass class names through 'className'/u);
    assert.match(result.output, /Do not pass class names through 'overlayClassName'/u);
  });

  it("allows className on an element and class composition inside the design system", async () => {
    await writeFixture(
      "apps/web/src/panel.tsx",
      `export const Panel = () => <div className="flex gap-2" />;\n`,
    );
    await writeFixture(
      "packages/ds/src/components/button-link.tsx",
      `declare const useRender: (options: object) => null;
export const ButtonLink = () => useRender({ props: { className: "inline-flex" } });\n`,
    );

    const result = runOxlint([
      "apps/web/src/panel.tsx",
      "packages/ds/src/components/button-link.tsx",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
