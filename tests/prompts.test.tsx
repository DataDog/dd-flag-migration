import { describe, expect, it, jest } from '@jest/globals';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ConfirmView } from '../src/components/Confirm.js';
import { FilterableCheckboxView } from '../src/components/FilterableCheckbox.js';
import { FilterableSelectView } from '../src/components/FilterableSelect.js';
import { InputView } from '../src/components/Input.js';
import { SelectView } from '../src/components/Select.js';

// Give ink's useEffect a chance to attach the input listener before writing,
// and to process each write before the next assertion.
async function tick(ms = 30): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

async function ready(): Promise<void> {
	await tick(40);
}

describe('SelectView', () => {
	it('renders choices and resolves with selected value on Enter', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin, lastFrame } = render(
			<SelectView<string>
				message="Pick one"
				choices={[
					{ name: 'first', value: 'a' },
					{ name: 'second', value: 'b' },
				]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		expect(stripAnsi(lastFrame() ?? '')).toContain('Pick one');
		expect(stripAnsi(lastFrame() ?? '')).toContain('first');
		stdin.write('\x1b[B'); // down arrow
		await tick();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith('b');
	});

	it('cancels on Escape', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<SelectView<string>
				message="Pick"
				choices={[{ name: 'a', value: 'a' }]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\x1b');
		await tick();
		expect(cancel).toHaveBeenCalled();
	});
});

describe('ConfirmView', () => {
	it('resolves true on y', async () => {
		const done = jest.fn<(v: boolean) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<ConfirmView message="Sure?" onDone={done} onCancel={cancel} />,
		);
		await ready();
		stdin.write('y');
		await tick();
		expect(done).toHaveBeenCalledWith(true);
	});

	it('uses default on Enter', async () => {
		const done = jest.fn<(v: boolean) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<ConfirmView
				message="Sure?"
				default={false}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith(false);
	});
});

describe('InputView', () => {
	it('captures typed input and resolves on Enter', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<InputView message="Enter value" onDone={done} onCancel={cancel} />,
		);
		await ready();
		stdin.write('hello');
		await tick();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith('hello');
	});

	it('rejects via validate and stays open', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin, lastFrame } = render(
			<InputView
				message="Enter"
				validate={(v) => (v.length > 0 ? true : 'Cannot be empty')}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\r');
		await tick(60);
		expect(done).not.toHaveBeenCalled();
		expect(stripAnsi(lastFrame() ?? '')).toContain('Cannot be empty');
	});

	it('uses default when submitted empty', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<InputView
				message="Enter"
				default="foo"
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith('foo');
	});
});

describe('FilterableCheckboxView', () => {
	it('matches typed search over chalked labels using plain-text substring', async () => {
		const done = jest.fn<(v: string[]) => void>();
		const cancel = jest.fn();
		const { stdin, lastFrame } = render(
			<FilterableCheckboxView<string>
				message="Pick"
				choices={[
					{ name: chalk.cyan('alpha-one'), value: 'a' },
					{ name: chalk.red('beta-two'), value: 'b' },
				]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('beta');
		await tick();
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('beta-two');
		expect(frame).not.toContain('alpha-one');
	});

	it('toggles selection with space and confirms with Enter', async () => {
		const done = jest.fn<(v: string[]) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<FilterableCheckboxView<string>
				message="Pick"
				choices={[
					{ name: 'a', value: 'a' },
					{ name: 'b', value: 'b' },
				]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write(' ');
		await tick();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith(['a']);
	});

	it('cancels on Escape', async () => {
		const done = jest.fn<(v: string[]) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<FilterableCheckboxView<string>
				message="Pick"
				choices={[{ name: 'a', value: 'a' }]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\x1b');
		await tick();
		expect(cancel).toHaveBeenCalled();
	});

	it('ctrl+a selects all visible', async () => {
		const done = jest.fn<(v: string[]) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<FilterableCheckboxView<string>
				message="Pick"
				choices={[
					{ name: 'a', value: 'a' },
					{ name: 'b', value: 'b' },
				]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\x01');
		await tick();
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith(['a', 'b']);
	});
});

describe('FilterableSelectView', () => {
	it('typed search filters over ANSI names', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin, lastFrame } = render(
			<FilterableSelectView<string>
				message="Pick"
				choices={[
					{ name: chalk.cyan('alpha'), value: 'a' },
					{ name: chalk.red('beta'), value: 'b' },
				]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('bet');
		await tick();
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('beta');
		expect(frame).not.toContain('alpha');
		stdin.write('\r');
		await tick();
		expect(done).toHaveBeenCalledWith('b');
	});

	it('cancels on Escape', async () => {
		const done = jest.fn<(v: string) => void>();
		const cancel = jest.fn();
		const { stdin } = render(
			<FilterableSelectView<string>
				message="Pick"
				choices={[{ name: 'a', value: 'a' }]}
				onDone={done}
				onCancel={cancel}
			/>,
		);
		await ready();
		stdin.write('\x1b');
		await tick();
		expect(cancel).toHaveBeenCalled();
	});
});
