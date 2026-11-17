import type { ESTree, SourceCode } from "@oxlint/plugins";

export const functionParameterTypeAnnotation = (
  parameter: ESTree.ParamPattern
): ESTree.TSTypeAnnotation | null | undefined => {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterTypeAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return (
      parameter.typeAnnotation ??
      functionParameterTypeAnnotation(parameter.argument)
    );
  }
  if (parameter.type === "AssignmentPattern") {
    return (
      parameter.typeAnnotation ??
      functionParameterTypeAnnotation(parameter.left)
    );
  }
  return parameter.typeAnnotation;
};

export const functionParameterBindingName = (
  parameter: ESTree.ParamPattern,
  sourceCode: SourceCode
): string => {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterBindingName(parameter.parameter, sourceCode);
  }
  if (parameter.type === "AssignmentPattern") {
    return functionParameterBindingName(parameter.left, sourceCode);
  }
  if (parameter.type === "RestElement") {
    return functionParameterBindingName(parameter.argument, sourceCode);
  }
  if (parameter.type === "Identifier") {
    return parameter.name;
  }

  const sourceText = sourceCode.getText(parameter);
  const annotationStart = parameter.typeAnnotation?.start;

  return annotationStart === undefined
    ? sourceText
    : sourceText.slice(0, annotationStart - parameter.start).trimEnd();
};
