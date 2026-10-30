import { createRequire } from 'node:module';

// Use the same TypeScript compiler as the package declaration checker.
const require = createRequire(import.meta.resolve('@arethetypeswrong/core'));
const ts = require('typescript');
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

export function publicDeclarationSignatures(text, minimum = 10) {
	const source = ts.createSourceFile('public.d.ts', text, ts.ScriptTarget.Latest, true);
	const declarations = source.statements
		.filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
		.map(node => printer.printNode(ts.EmitHint.Unspecified, node, source).trim());
	if (declarations.length < minimum) throw new Error('Too few exported declarations were extracted.');
	return declarations;
}

export function declarationSignatures(text, minimum = 10) {
	const source = ts.createSourceFile('index.d.ts', text, ts.ScriptTarget.Latest, true);
	const declarations = {};
	for (const node of source.statements) {
		if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			declarations[node.name.text] = printer.printNode(ts.EmitHint.Unspecified, node, source).trim();
		}
	}
	if (Object.keys(declarations).length < minimum) throw new Error('Too few public declarations were extracted.');
	return declarations;
}

export function interfaceMethodContracts(text, name) {
	const source = ts.createSourceFile('index.d.ts', text, ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === name);
	if (!declaration) throw new Error(`Missing interface ${name}`);
	// A parameter type naming an alias declared in the same file is compared by
	// what the alias stands for, so `RecognizedString` and its spelled-out union agree.
	const aliases = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node.type]));
	const typeText = node => {
		if (ts.isTypeReferenceNode(node) && !node.typeArguments && aliases.has(node.typeName.getText(source))) {
			return typeText(aliases.get(node.typeName.getText(source)));
		}
		return printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, ' ').trim();
	};
	return Object.fromEntries(declaration.members.filter(ts.isMethodSignature).map(member => [
		member.name.getText(source),
		{
			parameters: member.parameters.map(parameter => ({
				type: parameter.type ? typeText(parameter.type) : 'any',
				optional: !!parameter.questionToken,
				rest: !!parameter.dotDotDotToken
			})),
			returns: printer.printNode(ts.EmitHint.Unspecified, member.type, source).trim()
		}
	]));
}
