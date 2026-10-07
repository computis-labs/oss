export const startsWith = (reason: string) => ({
  asymmetricMatch: (actual: string) => actual.startsWith(reason),
  toAsymmetricMatcher: () => `StringStartingWith ${JSON.stringify(reason)}`,
});
