// prisma/seed.ts
// Seeds councils, then loads addresses + collection schedules exported from WordPress.
//
// Put the WordPress exports (CSV with header row, original column names) in prisma/data/:
//   prisma/data/addresses.csv   -> wp_cnaymun_addresses
//   prisma/data/schedules.csv   -> wp_cnaymun_collection_schedules
// If those files are missing, a few sample Karratha addresses are created instead.
//
// Uses the plain PrismaClient (not the ZenStack-enhanced one), so access policies don't block seeding.

import { PrismaClient, Prisma, RunType } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const DATA_DIR = path.join(__dirname, 'data');
const BATCH_SIZE = 1000;

// ─── Councils (same ids as WordPress so address.council_id still matches) ───
const councilData: Prisma.CouncilCreateInput[] = [
    { id: 1, name: 'Shire of Kalamunda', slug: 'kalamunda', legacyWpSiteId: 5 },
    { id: 2, name: 'City of Joondalup', slug: 'joondalup', legacyWpSiteId: 7 },
    { id: 4, name: 'City of Karratha', slug: 'karratha', legacyWpSiteId: 10 },
    { id: 5, name: 'Shire of Gwydir', slug: 'gwydir', legacyWpSiteId: 11 },
    { id: 6, name: 'City of Bayswater', slug: 'bayswater', legacyWpSiteId: 12 },
    { id: 7, name: 'Moree Plains Shire', slug: 'moree-plains', legacyWpSiteId: 13 },
    { id: 8, name: 'Narrabri Shire', slug: 'narrabri', legacyWpSiteId: 14 },
    { id: 9, name: 'Noosa Shire Council', slug: 'noosa', legacyWpSiteId: 15 },
];

// ─── Helpers for messy CSV values ───
type Row = Record<string, string>;

// MySQL exports write NULL as \N
const str = (v?: string) => (v === undefined || v === '' || v === 'NULL' || v === '\\N' ? null : v.trim());
const int = (v?: string) => {
    const s = str(v);
    if (s === null) return null;
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
};
const bool = (v?: string) => int(v) === 1;
// WordPress dates look like "2016-11-16 05:30:31" with no zone; treat them as UTC.
// Zero dates (0000-00-00 ...), blanks and anything unparseable return undefined,
// so the database default (now) is used instead of crashing the import.
let badDates = 0;
const date = (v?: string) => {
    const s = str(v);
    if (!s || s.startsWith('0000-00-00')) {
        if (s) badDates++;
        return undefined;
    }
    const d = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) {
        badDates++;
        if (badDates <= 5) console.warn(`  Invalid date "${s}", using now instead`);
        return undefined;
    }
    return d;
};
const runType = (v?: string): RunType | null => {
    const s = str(v)?.toUpperCase();
    return s && s in RunType ? (s as RunType) : null;
};

// Column order of the export queries (used when the file has no header row)
const ADDRESS_COLUMNS = ['id', 'council_id', 'customer_id', 'street_number', 'unit_string', 'street', 'postcode', 'suburb', 'created'];
const SCHEDULE_COLUMNS = ['id', 'address_id', 'runtype', 'dayofweek', 'weekly', 'weekstart', 'original_run', 'original_sequence', 'original_schedule', 'created'];

// Reads either a comma CSV with quotes, or a MySQL tab-separated export (no quotes, \N for NULL).
// Detects the delimiter and whether the first line is a header.
function readCsv(file: string, columns: string[]): Row[] {
    const text = readFileSync(path.join(DATA_DIR, file), 'utf8').replace(/^\uFEFF/, '');
    const firstLine = text.slice(0, text.indexOf('\n')).replace(/\r$/, '');
    const isTsv = firstLine.includes('\t');
    const delimiter = isTsv ? '\t' : ',';
    const hasHeader = firstLine.split(delimiter)[0].replace(/"/g, '').trim().toLowerCase() === 'id';

    const rows: Row[] = parse(text, {
        delimiter,
        columns: hasHeader ? true : columns,
        from_line: 1,
        skip_empty_lines: true,
        trim: true,
        quote: isTsv ? false : '"', // MySQL TSV doesn't quote; commas inside values are fine
        relax_column_count: true,   // tolerate a stray short or long line instead of aborting
    });

    // MySQL TSV escapes tabs/newlines/backslashes inside values
    if (isTsv) {
        for (const r of rows) {
            for (const k of Object.keys(r)) {
                if (r[k] !== '\\N') r[k] = r[k].replace(/\\t/g, '\t').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
            }
        }
    }

    console.log(`Read ${rows.length} rows from ${file} (${isTsv ? 'tab' : 'comma'}-separated, ${hasHeader ? 'with' : 'no'} header)`);
    return rows;
}

async function inBatches<T>(rows: T[], label: string, insert: (batch: T[]) => Promise<{ count: number }>) {
    let total = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const { count } = await insert(rows.slice(i, i + BATCH_SIZE));
        total += count;
        console.log(`  ${label}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
    }
    return total;
}

// Explicit ids leave Postgres sequences behind; move them past the max id
async function resetSequence(table: string) {
    await prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
    );
}

// ─── Seed steps ───
async function seedCouncils() {
    for (const c of councilData) {
        const council = await prisma.council.upsert({
            where: { id: c.id },
            create: c,
            update: { name: c.name, slug: c.slug },
        });
        console.log(`Upserted council ${council.id}: ${council.name}`);
    }
    await resetSequence('councils');
}

async function seedAddressesFromCsv() {
    const validCouncils = new Set(councilData.map((c) => c.id));
    const rows = readCsv('addresses.csv', ADDRESS_COLUMNS);

    const addresses: Prisma.AddressCreateManyInput[] = [];
    let skipped = 0;
    for (const r of rows) {
        const id = int(r.id);
        const councilId = int(r.council_id);
        if (!id || !councilId || !validCouncils.has(councilId)) {
            skipped++;
            continue;
        }
        addresses.push({
            id,
            councilId,
            customerId: str(r.customer_id),
            streetNumber: int(r.street_number),
            unit: str(r.unit_string),
            street: str(r.street),
            suburb: str(r.suburb),
            postcode: str(r.postcode),
            createdAt: date(r.created),
        });
    }

    console.log(`Importing ${addresses.length} addresses (${skipped} skipped: unknown council or bad id)`);
    const n = await inBatches(addresses, 'addresses', (batch) =>
        prisma.address.createMany({ data: batch, skipDuplicates: true })
    );
    console.log(`Inserted ${n} new addresses`);
    await resetSequence('addresses');
}

async function seedSchedulesFromCsv() {
    const existing = new Set((await prisma.address.findMany({ select: { id: true } })).map((a) => a.id));
    const rows = readCsv('schedules.csv', SCHEDULE_COLUMNS);

    const schedules: Prisma.CollectionScheduleCreateManyInput[] = [];
    let skipped = 0;
    for (const r of rows) {
        const id = int(r.id);
        const addressId = int(r.address_id);
        const type = runType(r.runtype);
        if (!id || !addressId || !existing.has(addressId) || !type) {
            skipped++;
            continue;
        }
        schedules.push({
            id,
            addressId,
            runType: type,
            dayOfWeek: int(r.dayofweek) ?? 1,
            weekly: bool(r.weekly),
            weekStart: int(r.weekstart) ?? 1,
            originalRun: str(r.original_run),
            originalSequence: str(r.original_sequence),
            originalSchedule: str(r.original_schedule),
            createdAt: date(r.created),
        });
    }

    console.log(`Importing ${schedules.length} schedules (${skipped} skipped: missing address or unknown runtype)`);
    const n = await inBatches(schedules, 'schedules', (batch) =>
        prisma.collectionSchedule.createMany({ data: batch, skipDuplicates: true })
    );
    console.log(`Inserted ${n} new schedules`);
    await resetSequence('collection_schedules');
}

// Fallback when no CSV export is present: a few made-up Karratha addresses for testing
async function seedSampleAddresses() {
    const samples: Prisma.AddressCreateInput[] = [
        {
            council: { connect: { id: 4 } },
            customerId: 'SAMPLE-0001',
            streetNumber: 12,
            street: 'Sample Street',
            suburb: 'Bulgarra',
            postcode: '6714',
            schedules: {
                create: [
                    { runType: 'GAR', dayOfWeek: 2, weekly: true },
                    { runType: 'REC', dayOfWeek: 2, weekly: false, weekStart: 1 },
                ],
            },
        },
        {
            council: { connect: { id: 4 } },
            customerId: 'SAMPLE-0002',
            streetNumber: 5,
            unit: '3',
            street: 'Test Avenue',
            suburb: 'Millars Well',
            postcode: '6714',
            schedules: {
                create: [
                    { runType: 'GAR', dayOfWeek: 4, weekly: true },
                    { runType: 'REC', dayOfWeek: 4, weekly: false, weekStart: 2 },
                ],
            },
        },
    ];

    for (const a of samples) {
        const address = await prisma.address.upsert({
            where: { councilId_customerId: { councilId: 4, customerId: a.customerId! } },
            create: a,
            update: {},
        });
        console.log(`Upserted sample address ${address.id}: ${address.streetNumber} ${address.street}`);
    }
}

// First admin user, from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
// The raw client doesn't apply ZenStack's @password hashing, so hash here with bcrypt (same as ZenStack).
async function seedAdmin() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
        console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping admin user.');
        return;
    }
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        console.log(`Admin ${email} already exists (password unchanged).`);
        return;
    }
    await prisma.user.create({
        data: { email, password: await bcrypt.hash(password, 10), role: 'ADMIN' },
    });
    console.log(`Created admin user ${email}`);
}

// Read one address back to confirm everything is linked
async function checkAddress() {
    const address = await prisma.address.findFirst({
        where: { council: { slug: 'karratha' } },
        include: { council: true, schedules: true },
        orderBy: { id: 'asc' },
    });
    if (!address) {
        console.log('No Karratha addresses found.');
        return;
    }
    const label = [address.unit && `${address.unit}/`, address.streetNumber, address.street, address.suburb, address.postcode]
        .filter(Boolean)
        .join(' ');
    console.log(`\nCheck: ${label} (${address.council.name})`);
    for (const s of address.schedules) {
        console.log(`  ${s.runType} - day ${s.dayOfWeek}, ${s.weekly ? 'weekly' : `fortnightly (week ${s.weekStart})`}`);
    }

    const counts = await prisma.address.groupBy({ by: ['councilId'], _count: { _all: true } });
    console.log('\nAddresses per council:', counts.map((c) => `${c.councilId}=${c._count._all}`).join(', '));
}

async function main() {
    console.log('Start seeding ...');
    await seedCouncils();
    await seedAdmin();

    if (existsSync(path.join(DATA_DIR, 'addresses.csv'))) {
        await seedAddressesFromCsv();
        if (existsSync(path.join(DATA_DIR, 'schedules.csv'))) {
            await seedSchedulesFromCsv();
        } else {
            console.log('No schedules.csv found, skipping schedules.');
        }
    } else {
        console.log('No addresses.csv found, creating sample addresses instead.');
        await seedSampleAddresses();
    }

    if (badDates > 0) console.log(`\n${badDates} rows had an empty or invalid date (set to now).`);
    await checkAddress();
    console.log('\nSeeding finished.');
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error(e);
        await prisma.$disconnect();
        process.exit(1);
    });