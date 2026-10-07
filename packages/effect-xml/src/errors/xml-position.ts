export interface XmlPosition {
  readonly column: number;
  readonly line: number;
  readonly offset: number;
}

export const describePosition = ({
  column,
  line,
}: {
  readonly column: number;
  readonly line: number;
}) => `(line ${String(line)}, column ${String(column)})`;
