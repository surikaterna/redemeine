import { resolve } from 'node:path';
import * as ts from 'typescript';

export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, seen = new Set<ts.Symbol>()): ts.Symbol {
  const target = unalias(checker, symbol);
  if (seen.has(target)) throw new Error('cyclic definition alias');
  if (seen.size >= 64) throw new Error('definition alias chain exceeds supported depth');
  seen.add(target);
  const declaration = target.valueDeclaration;
  let expression: ts.Expression | undefined;
  if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const) expression = declaration.initializer;
  if (declaration && ts.isExportAssignment(declaration)) expression = declaration.expression;
  if (!expression || !ts.isIdentifier(expression)) return target;
  const next = checker.getSymbolAtLocation(expression);
  const nextDeclaration = next && unalias(checker, next).valueDeclaration;
  if (nextDeclaration && ts.isVariableDeclaration(nextDeclaration) && ts.isVariableDeclarationList(nextDeclaration.parent) &&
      !(nextDeclaration.parent.flags & ts.NodeFlags.Const)) return target;
  return next ? canonicalSymbol(checker, next, seen) : target;
}

function typeOnlyDeclaration(node: ts.Declaration): boolean {
  if (ts.isExportSpecifier(node)) return node.isTypeOnly || (ts.isExportDeclaration(node.parent.parent) && node.parent.parent.isTypeOnly);
  if (ts.isImportSpecifier(node)) return node.isTypeOnly || node.parent.parent.isTypeOnly;
  return ts.isImportClause(node) && node.isTypeOnly;
}

function exportRoute(checker: ts.TypeChecker, statement: ts.ExportDeclaration, name: string, seen: Set<string>): boolean {
  if (statement.isTypeOnly) return false;
  let targetName = name;
  if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    const element = statement.exportClause.elements.find((item) => item.name.text === name && !item.isTypeOnly);
    if (!element) return false;
    targetName = (element.propertyName ?? element.name).text;
    if (!statement.moduleSpecifier) {
      const target = checker.getExportSpecifierLocalTargetSymbol(element);
      return !!target && !target.declarations?.some(typeOnlyDeclaration) && !!(unalias(checker, target).flags & ts.SymbolFlags.Value);
    }
  }
  if (!statement.moduleSpecifier) return false;
  const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
  return !!module?.declarations?.some((declaration) => ts.isSourceFile(declaration) && valueRoute(checker, declaration, targetName, seen));
}

function bindingContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => ts.isBindingElement(element) && bindingContains(element.name, name));
}

function valueRoute(checker: ts.TypeChecker, source: ts.SourceFile, name: string, seen = new Set<string>()): boolean {
  const key = `${source.fileName}:${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (exportRoute(checker, statement, name, seen)) return true;
      continue;
    }
    if (ts.isExportAssignment(statement) && name === 'default') return true;
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (name === 'default' && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindingContains(declaration.name, name))) return true;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        statement.name?.text === name) return true;
  }
  return false;
}

export function moduleValues(program: ts.Program, entry: string): Map<string, ts.Symbol> {
  const source = program.getSourceFile(resolve(entry));
  if (!source) throw new Error(`${entry}: entry not in compiler program`);
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${entry}: expected an exported module`);
  const exports = checker.getExportsOfModule(module);
  return new Map(exports.filter((symbol) => {
    if (symbol.declarations?.some(typeOnlyDeclaration)) return false;
    const target = unalias(checker, symbol);
    return !!(target.flags & ts.SymbolFlags.Value) && valueRoute(checker, source, symbol.name);
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((symbol) => [symbol.name, symbol]));
}

export function selectedSymbol(program: ts.Program, entry: string, name: string): ts.Symbol {
  const symbol = moduleValues(program, entry).get(name);
  if (!symbol) throw new Error(`${entry}: missing value export ${name}`);
  return canonicalSymbol(program.getTypeChecker(), symbol);
}

export function valueType(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type {
  const target = unalias(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (!declaration) throw new Error(`${symbol.name}: unresolved value declaration`);
  return checker.getTypeOfSymbolAtLocation(target, declaration);
}
