import { describe, expect, it } from 'vitest';
import { unassignedFiles } from '../../src/core/unassigned';

describe('unassignedFiles', () => {
	it('keeps only files no changelist claims', () => {
		const files = unassignedFiles(
			['a.dart', 'b.dart', 'c.dart', 'd.dart'],
			new Set(['b.dart']),
			new Set(['c.dart'])
		);
		expect(files).toEqual(['a.dart', 'd.dart']);
	});

	it('returns nothing when everything is claimed', () => {
		expect(unassignedFiles(['a.dart'], new Set(['a.dart']), new Set())).toEqual([]);
	});
});
