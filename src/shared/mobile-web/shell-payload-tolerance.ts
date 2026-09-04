import { z } from 'zod'

type AnySchema = z.ZodType<unknown>
type SchemaDef = Record<string, unknown> & { type: string }

const rewritten = new WeakMap<object, AnySchema>()

/**
 * Rewrites a shell-authored payload schema so an additive change in a newer APK degrades instead of
 * bricking an older page. The shell (APK) and the page (served by the desktop) ship from different
 * releases, and a page parse failure is permanent: `invalid_message` is not retryable and nothing
 * re-subscribes. Three relaxations, each the forward-compatible reading of a closed shape: unknown
 * object keys are stripped rather than rejected, a member an array-of-unions cannot classify is
 * dropped rather than failing the whole array, and an unknown value for an optional/nullable closed
 * set collapses to absent rather than failing its parent.
 *
 * Only the shell->page direction. Page->shell request schemas stay `.strict()`: there the shell is
 * the authority and a loud `invalid_request` is the security fence.
 */
export function tolerantMobileWebShellPayload<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return loosen(schema as AnySchema) as unknown as z.ZodType<T>
}

function loosen(schema: AnySchema): AnySchema {
  const cached = rewritten.get(schema)
  if (cached) {
    return cached
  }
  const built = rebuild(schema)
  rewritten.set(schema, built)
  return built
}

function definitionOf(schema: AnySchema): SchemaDef {
  return (schema as unknown as { _zod: { def: SchemaDef } })._zod.def
}

function cloned(schema: AnySchema, def: SchemaDef): AnySchema {
  return (schema as unknown as { clone: (def: SchemaDef) => AnySchema }).clone(def)
}

function rebuild(schema: AnySchema): AnySchema {
  const def = definitionOf(schema)
  switch (def.type) {
    case 'object':
      return rebuiltObject(schema, def)
    case 'array':
      return rebuiltArray(schema, def)
    case 'union':
      return cloned(schema, { ...def, options: (def.options as AnySchema[]).map(loosen) })
    case 'optional':
    case 'nullable':
      return rebuiltClosedSetWrapper(schema, def)
    case 'nonoptional':
    case 'readonly':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'promise':
      return cloned(schema, { ...def, innerType: loosen(def.innerType as AnySchema) })
    case 'lazy': {
      const getter = def.getter as () => AnySchema
      return cloned(schema, { ...def, getter: () => loosen(getter()) })
    }
    case 'pipe':
      return cloned(schema, {
        ...def,
        in: loosen(def.in as AnySchema),
        out: loosen(def.out as AnySchema)
      })
    case 'intersection':
      return cloned(schema, {
        ...def,
        left: loosen(def.left as AnySchema),
        right: loosen(def.right as AnySchema)
      })
    case 'record':
    case 'map':
    case 'set':
      return cloned(schema, { ...def, valueType: loosen(def.valueType as AnySchema) })
    case 'tuple':
      return cloned(schema, {
        ...def,
        items: (def.items as AnySchema[]).map(loosen),
        rest: def.rest ? loosen(def.rest as AnySchema) : def.rest
      })
    default:
      return schema
  }
}

function rebuiltObject(schema: AnySchema, def: SchemaDef): AnySchema {
  const shape = Object.fromEntries(
    Object.entries(def.shape as Record<string, AnySchema>).map(([key, value]) => [
      key,
      loosen(value)
    ])
  )
  const catchall = def.catchall as AnySchema | undefined
  const strict = catchall !== undefined && definitionOf(catchall).type === 'never'
  return cloned(schema, {
    ...def,
    shape,
    catchall: strict || catchall === undefined ? undefined : loosen(catchall)
  })
}

/** Length checks stay on the raw array so a wire-size cap still rejects before any member parses. */
function rebuiltArray(schema: AnySchema, def: SchemaDef): AnySchema {
  const element = loosen(def.element as AnySchema)
  if (!isUnion(def.element as AnySchema)) {
    return cloned(schema, { ...def, element })
  }
  return cloned(schema, { ...def, element: z.unknown() }).transform((items) =>
    (items as unknown[]).flatMap((item) => {
      const parsed = element.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  ) as unknown as AnySchema
}

/** An unknown member of a closed set reads as "absent" so it cannot fail the payload around it. */
function rebuiltClosedSetWrapper(schema: AnySchema, def: SchemaDef): AnySchema {
  const wrapper = cloned(schema, { ...def, innerType: loosen(def.innerType as AnySchema) })
  if (!isClosedSet(def.innerType as AnySchema)) {
    return wrapper
  }
  return wrapper.catch((def.type === 'nullable' ? null : undefined) as never)
}

function isUnion(schema: AnySchema): boolean {
  return definitionOf(schema).type === 'union'
}

function isClosedSet(schema: AnySchema): boolean {
  const def = definitionOf(schema)
  if (def.type === 'enum' || def.type === 'literal') {
    return true
  }
  if (def.type === 'optional' || def.type === 'nullable') {
    return isClosedSet(def.innerType as AnySchema)
  }
  return def.type === 'union' && (def.options as AnySchema[]).every(isClosedSet)
}
