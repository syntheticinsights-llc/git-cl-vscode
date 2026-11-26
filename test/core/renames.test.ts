import { describe, expect, it } from 'vitest';
import { groupedRenames, visibleFiles } from '../../src/core/renames';

describe('renames', () => {
	it('groups a rename only when both sides are in the same list', () => {
		const renames = new Map([
			['lib/new.dart', 'lib/old.dart'],
			['doc/new.md', 'doc/old.md'],
		]);
		const grouped = groupedRenames(renames, ['lib/new.dart', 'lib/old.dart', 'doc/new.md']);
		expect([...grouped]).toEqual([['lib/new.dart', 'lib/old.dart']]);
	});

	it('hides the original half of a grouped rename', () => {
		const renames = new Map([['lib/new.dart', 'lib/old.dart']]);
		expect(visibleFiles(['lib/new.dart', 'lib/old.dart', 'lib/other.dart'], renames))
			.toEqual(['lib/new.dart', 'lib/other.dart']);
	});
});
