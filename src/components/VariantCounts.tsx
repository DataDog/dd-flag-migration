import { Text } from 'ink';

export type VariantCountsValue = {
	added: number;
	updated: number;
	deleted: number;
};

export function formatVariantCounts(counts: VariantCountsValue): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`${counts.added} variant(s) added`);
	if (counts.updated > 0) parts.push(`${counts.updated} variant(s) updated`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} variant(s) deleted`);
	return parts.join(', ');
}

export function formatVariantLabel(counts: VariantCountsValue): string {
	const label = formatVariantCounts(counts);
	return label.length > 0 ? `, ${label}` : '';
}

export type VariantCountsProps = {
	counts: VariantCountsValue;
	prefix?: string;
};

export function VariantCounts({
	counts,
	prefix = ', ',
}: VariantCountsProps): JSX.Element {
	const label = formatVariantCounts(counts);
	return <Text>{label.length > 0 ? `${prefix}${label}` : ''}</Text>;
}
