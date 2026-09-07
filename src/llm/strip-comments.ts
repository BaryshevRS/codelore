import ts from "typescript";

// After these tokens a `/` is division, not a regex start; everywhere else the
// scanner must re-scan the slash as a regex literal so `//` inside a pattern
// is not mistaken for a comment.
const DIVISION_CONTEXT_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

/**
 * Removes comments from a TS/JS fragment. Comments are unverified prose: the
 * verifier must check documentation against executable code only, not against
 * whatever a comment claims the code does.
 */
export function stripComments(source: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, source);
  let result = "";
  let previousSignificant: ts.SyntaxKind | undefined;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      (previousSignificant === undefined || !DIVISION_CONTEXT_TOKENS.has(previousSignificant))
    ) {
      token = scanner.reScanSlashToken();
    }
    const isComment = token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia;
    if (!isComment) {
      result += source.slice(scanner.getTokenStart(), scanner.getTokenEnd());
      if (token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia) {
        previousSignificant = token;
      }
    }
    token = scanner.scan();
  }
  // Comment removal leaves blank lines behind; collapse them so the verifier
  // does not read holes as missing code.
  return result.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}
