/**
 * el-45m5h: AST scan of production call sites of @stoneforge/core element
 * factories; prints NO-CONFIG when no IdGeneratorConfig (2nd arg) is passed,
 * i.e. generateId uses default length 4 and no collision check.
 * Run from repository root: bun docs/workspace/id-base36-bias-el-45m5h/callers.ts | sort
 * Known false positive: apps/smithy-next SettingsOverlay createTeam (local UI fn).
 */
import ts from 'typescript';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const FACTORIES = new Set(['createTask','createDocument','createMessage','createEntity','createGroupChannel','createDirectChannel','createLibrary','createPlan','createPlaybook','createTeam','createWorkflow']);
const files = execSync("git ls-files 'packages/*.ts' 'apps/*.ts' 'apps/*.tsx'", {encoding:'utf8'}).split('\n')
  .filter(f => f && !/\.test\.|\/test\/|__tests__|\/e2e\/|\/tests\//.test(f) && !f.startsWith('packages/core/src/types/'));
for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f,'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
      if (FACTORIES.has(name) && !ts.isPropertyAccessExpression(n.expression)) {
        const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const arg2 = n.arguments[1]?.getText().replace(/\s+/g,' ').slice(0,60) ?? '<none>';
        console.log(`${arg2 === '<none>' ? 'NO-CONFIG' : 'config   '} ${f}:${line} ${name} ${arg2}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
