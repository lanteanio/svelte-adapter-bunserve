import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../leak/run.mjs', import.meta.url));
const plan = new URL('../leak/plan.mjs', import.meta.url).href;
const guard = '__invalid_cli_test_scenario__';
const readPlan = `
process.argv = ['node', 'plan', ...process.argv.slice(1)];
const { MINUTES, WINDOW_MS, OUT_DIR, SELECTED } = await import(${JSON.stringify(plan)});
console.log(JSON.stringify({ minutes: MINUTES, windowMs: WINDOW_MS, out: OUT_DIR, selected: SELECTED }));
`;

function execute(args) {
	const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.signal, null);
	return result;
}

function settings(args) {
	const result = execute(['--input-type=module', '-e', readPlan, '--', ...args]);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function refused(args, message) {
	// The invalid scenario is an independent guard against a broken minutes or
	// output parser starting a measurement. Node also cannot run the Bun build.
	const result = execute([runner, ...args, '--scenario', guard]);
	assert.equal(result.status, 2, result.stderr);
	assert.match(result.stderr, message);
	assert.doesNotMatch(result.stdout + result.stderr, /== build fixture|warmup|ReferenceError/);
}

const spellings = [
	(name, value) => [`--${name}`, value],
	(name, value) => [`--${name}=${value}`]
];

test('the executable plan defaults to three minutes and includes churn', () => {
	const actual = settings([]);
	assert.equal(actual.minutes, 3);
	assert.equal(actual.windowMs, 180_000);
	assert.deepEqual(actual.selected, ['http', 'ws', 'churn', 'selfcheck']);
});

test('both minutes spellings accept inclusive numeric windows before scenario validation', () => {
	for (const flags of spellings) {
		for (const raw of ['1', '3', '60', '1.5', '1e1']) {
			const args = flags('minutes', raw);
			const actual = settings(args);
			assert.equal(actual.minutes, Number(raw));
			assert.equal(actual.windowMs, Number(raw) * 60_000);
			refused(args, /unknown scenario "__invalid_cli_test_scenario__"/);
		}
	}
});

test('invalid numeric windows fail before the fixture build in both spellings', () => {
	for (const flags of spellings) {
		for (const raw of ['abc', '2m', 'NaN', 'Infinity', '-Infinity', '0', '0.5', '-1', '61', '1e999']) {
			refused(flags('minutes', raw), /--minutes .* (?:not a number|out of range)/);
		}
	}
});

test('all named flags refuse missing and empty first values before building', () => {
	for (const name of ['minutes', 'scenario', 'out']) {
		for (const args of [[`--${name}`], [`--${name}`, ''], [`--${name}`, '  '], [`--${name}=`]]) {
			refused(args, new RegExp(`--${name} needs a value`));
		}
	}
});

test('scenario and output flags accept both forms and preserve embedded equals', () => {
	for (const flags of spellings) {
		for (const scenario of ['http', 'ws', 'churn', 'selfcheck', 'all']) {
			const actual = settings([...flags('scenario', scenario), ...flags('out', 'records/a=b=c')]);
			assert.deepEqual(actual.selected, scenario === 'all' ? ['http', 'ws', 'churn', 'selfcheck'] : [scenario]);
			assert.equal(actual.out, 'records/a=b=c');
		}
		refused(flags('scenario', guard), /unknown scenario "__invalid_cli_test_scenario__"/);
	}
});

test('the first occurrence wins across both spellings, including later empty or missing values', () => {
	for (const first of spellings) {
		for (const later of spellings) {
			const actual = settings([
				...first('minutes', '1.5'), ...later('minutes', 'invalid'),
				...first('scenario', 'churn'), ...later('scenario', 'invalid'),
				...first('out', 'a=b'), ...later('out', 'other')
			]);
			assert.equal(actual.minutes, 1.5);
			assert.deepEqual(actual.selected, ['churn']);
			assert.equal(actual.out, 'a=b');
		}
	}
	assert.equal(settings(['--minutes=1.5', '--minutes=', '--minutes']).minutes, 1.5);
	assert.equal(settings(['--out=a=b', '--out=', '--out']).out, 'a=b');
	assert.deepEqual(settings(['--scenario=churn', '--scenario=', '--scenario']).selected, ['churn']);
	refused(['--minutes=', '--minutes=3'], /--minutes needs a value/);
	refused(['--scenario', guard, '--scenario=all'], /unknown scenario "__invalid_cli_test_scenario__"/);
});
