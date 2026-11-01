# Смещение старшей base36-цифры в generateId — el-45m5h

Оценка (без изменения production-кода). Обнаружено при el-1w48v.
Методика: точный расчёт в BigInt + Monte Carlo (10^6 digest) через production
`toBase36`/`truncateHash` на base `1b43de2` (bun 1.3.11, exit 0) и AST-скан
вызовов фабрик ID. Ad-hoc скрипты и их логи удалены из репозитория перед
публикацией (el-ju3fwi); ключевые числа приведены ниже, формулы — в
`packages/core/src/id/generator-distribution.bun.test.ts`.

## Механизм

`generateIdHash` → `toBase36(SHA-256)` без ведущих нулей; `truncateHash` берёт
**старшие** L символов (L = 3..8). 36^49 < 2^256 ≈ 36^49.517 < 36^50, поэтому:

- 84.3% digest имеют 50 base36-цифр; старшая цифра = floor(D/36^49) ∈ 1..6
  (2^256/36^49 ≈ 6.37): `1..5` по 16.12%, `6` — 6.41%.
- 15.7% имеют ≤49 цифр; их старшая цифра почти равномерна по 1..z: `7..z` по 0.448%.
- `0` первым символом не встречается никогда (2.78% пространства недостижимо).
- Второй символ смещён слабо (0..c 3.05%, e..z 2.61%; Σp² 0.02794 против 0.02778).
  Остальные символы практически равномерны.

## Точные результаты

Σp² = вероятность совпадения двух независимых ID одной длины.

| L | Σp² точно | равномерно 36^-L | ×  | H2, бит | номинал, бит | потеря, бит |
|---|-----------|------------------|----|---------|--------------|-------------|
| 3 | 1.0834e-4 | 2.1433e-5 | 5.055 | 13.17 | 15.51 | 2.34 |
| 4 | 3.0096e-6 | 5.9537e-7 | 5.055 | 18.34 | 20.68 | 2.34 |
| 5 | 8.3601e-8 | 1.6538e-8 | 5.055 | 23.51 | 25.85 | 2.34 |
| 6 | 2.3223e-9 | 4.5939e-10 | 5.055 | 28.68 | 31.02 | 2.34 |
| 7 | 6.4507e-11 | 1.2761e-11 | 5.055 | 33.85 | 36.19 | 2.34 |
| 8 | 1.7919e-12 | 3.5447e-13 | 5.055 | 39.02 | 41.36 | 2.34 |

Только для первого символа ×4.847 (Σp² 0.13463). Monte Carlo 10^6 digest
совпадает с точным расчётом (L=4: 3.009e-6 против 3.0096e-6). Ранняя оценка
el-1w48v (2.87e-6, ×4.8, 200k выборок) занижена: точное значение ×5.055.

Итог: эффективная (коллизионная) энтропия каждого ID на ~2.34 бита ниже
номинальной — эквивалентно потере ~0.45 base36-символа при любой длине.

## Влияние

Оценки для пополнения из N существующих ID (приближение: существующие ID имеют
то же распределение; на практике часть ID получена после retry на большей длине).

**Пороги `calculateIdLength`** (комментарий заявляет «~1% collision probability»):

| L | N (верх диапазона) | P(новый ID = один из N) факт / равномерно | P(хотя бы одна пара среди N) факт / равномерно |
|---|---|---|---|
| 3 | 100 | 1.08% / 0.21% | 41.5% / 10.1% |
| 4 | 500 | 0.150% / 0.030% | 31.3% / 7.2% |
| 5 | 3000 | 0.025% / 0.005% | 31.4% / 7.2% |
| 6 | 20000 | 0.005% / 0.001% | 37.2% / 8.8% |
| 7 | 100000 | 0.001% / <0.001% | 27.6% / 6.2% |

Даже при равномерном распределении пороги дают ~7–10% парных коллизий, а не 1%;
смещение поднимает это до ~30–40%. Отдельное расхождение документации/порогов.

**Пути с `checkCollision`** (`QuarryAPI.getIdGeneratorConfig()`): коллизия не
приводит к дубликату — nonce retry (до 10 на длину), затем увеличение длины.
Смещение лишь ≈ в 5 раз учащает retry/запросы `get(id)` и `length_increase`.

**Пути без конфигурации** (длина по умолчанию 4, без проверки коллизий).
AST-скан вызовов: 37 вызовов фабрик `@stoneforge/core` без
`IdGeneratorConfig` (32 с конфигурацией). Без учёта ложного срабатывания
(`apps/smithy-next` SettingsOverlay — локальная UI-функция) и тестового
`smithy/src/testing/test-context.ts` остаётся 35 production-вызовов, например:
`smithy` dispatch-service (createDocument/createMessage), handoff (×4),
agent-pool-service createEntity, merge-steward-service createTask,
role-definition-service, server routes tasks/workflows; `shared-routes`
channels/documents/messages/plans/libraries; `quarry` CLI channel/init/message/plan,
`QuarryAPI` createDirectChannel (quarry-api.ts:3432), server createPlaybook;
`apps/smithy-server` routes tasks/workflows.
Там коллизия = попытка вставить существующий `elements.id` (ср. el-2zj6n).
Вероятность на одну вставку при N элементах в БД:

| N | факт | равномерно |
|---|------|------------|
| 500 | 0.150% | 0.030% |
| 1323 (текущий workspace, `sf stats`) | 0.397% | 0.079% |
| 3000 | 0.899% | 0.178% |
| 10000 | 2.97% | 0.59% |

Главный риск — эти непроверяемые пути; смещение умножает его на ~5, но даже
равномерный 4-символьный ID без проверки растёт линейно с N. Исправление
смещения не заменяет передачу `getIdGeneratorConfig()` (или проверку на вставке).

## Варианты исправления (требуют решения Director)

Существующие ID не пересчитываются нигде в production: `toBase36`,
`truncateHash`, `generateIdHash` используются только внутри `generateId` и в
`generator.bun.test.ts`; ID хранятся как непрозрачные строки. `ROOT_ID_PATTERN`
`/^el-[0-9a-z]{3,8}$/` уже допускает ведущий `0`.

1. **Младшие L цифр** — `D mod 36^L`, дополнить нулями слева до L. Точный
   избыток Σp² над равномерным = r(M−r)/2^512 (M=36^L, r=2^256 mod M), ≤5e-131
   для L≤8 — практически ноль. Восстанавливает ~2.34 бита. Совместимо с
   `ROOT_ID_PATTERN` и существующими ID (новые просто распределены равномерно;
   коллизии со старыми ловит тот же `checkCollision`). При увеличении длины
   новый ID = старый с дополнительным старшим символом — то же свойство, что и
   сейчас (сейчас — дополнительный младший). Меняется детерминированный вывод
   `generateIdHash`/ID для заданного входа: проверить тесты, сравнивающие
   конкретные значения, и описание в `packages/core/README.md`.
2. **Отбросить первый символ** (брать символы 2..L+1 из 50-значной строки) —
   остаётся слабое смещение второго символа и зависимость от длины строки;
   хуже варианта 1, не рекомендуется.
3. **Ничего не менять в кодировании**, но повысить пороги/длину на +1 символ
   (компенсирует ~2.34 бита с запасом). Меняет вид ID, не устраняет
   недостижимый ведущий `0`.

Рекомендация: вариант 1 + отдельно перевести вызовы без `IdGeneratorConfig` на
проверку коллизий и пересмотреть пороги `LENGTH_THRESHOLDS` (в т.ч. текст «~1%»).

## Ограничения

- Модель предполагает равномерность SHA-256; входы (identifier/createdBy/ns-время/nonce)
  уникальны, этого достаточно.
- Оценки «N существующих» — приближение независимости; реальная популяция
  смешана по длинам и содержит ID, выбранные после retry.
- Production-код не изменён; тесты не запускались (не затронуты).

---

## Addendum (el-4rgbi0, 2026-11-01): review corrections and outcome

The original el-45m5h text above is kept unchanged as historical evidence. The
original commit was `cb11f7a`, carried onto the el-4rgbi0 branch with
`git cherry-pick -x`. The independent steward review of `cb11f7a` (shared reference
el-3uxnw) returned CHANGES REQUIRED. Read the sections above with these
qualifications:

1. **«Пути с `checkCollision`… коллизия не приводит к дубликату» is too strong.**
   `checkCollision` (`api.get(id)`) is a read-only pre-check against IDs that are
   already persisted. It is not a reservation. Two overlapping generations can
   return the same ID, and the later `api.create` fails with `ALREADY_EXISTS`. The
   steward reproduced this with a controlled digest schedule. Fixing it is out of
   scope for el-4rgbi0.
2. **«≈ в 5 раз учащает retry/запросы `get(id)` и `length_increase»` is
   unsupported.** The ~5.055× factor applies to the pair-collision probability (Σp²)
   under the stated model. It does not apply to total lookups, which already
   include one initial lookup per generation. For collision probability q,
   expected lookups are about 1/(1−q), and exhaustion of all 10 nonces is about
   q^10. At N = 500 and L = 4 this gives a lookup ratio of about 1.0012 and an
   exhaustion ratio of about 1.1e7, though both exhaustion probabilities are tiny.
3. **The formula r(M−r)/2^512 is the relative excess** (M·Σp² − 1). The absolute
   excess is that value divided by M. At L = 8 the relative excess is 5.028e-131.
   The 5.055× figure holds for L = 3..8; at L = 2 it is 5.0499×.
4. SHA-256 uniformity is a model assumption. It is not guaranteed by input
   uniqueness.

**Outcome (Director decision 2026-11-01, implemented in el-4rgbi0):**

- Option 1 is adopted: `generateId` now takes the low-order L digits.
- The default length without config is 6.
- The `calculateIdLength` thresholds are unchanged, but their "~1%" comment is
  corrected.

See `../id-generator-contract.md`. The analysis script still ran on el-4rgbi0
(exported `toBase36` and `truncateHash` are unchanged, so it describes the
**previous** production method): 200000 samples, exit 0, empirical results
consistent with the exact values. The script and logs are no longer kept in the
repository; the exact leading-digit counts are reproduced by the negative control
in `packages/core/src/id/generator-distribution.bun.test.ts`.
