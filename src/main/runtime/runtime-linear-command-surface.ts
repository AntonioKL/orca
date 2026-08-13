import { RuntimeLinearBrowseCommands } from './runtime-linear-browse-commands'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'

type PublicMethods<T> = Pick<T, keyof T>

export type RuntimeLinearCommandSurface = PublicMethods<RuntimeLinearCommands> &
  PublicMethods<RuntimeLinearBrowseCommands>

type LinearFacadeInstance = {
  linearCommands: RuntimeLinearCommands
  linearBrowseCommands: RuntimeLinearBrowseCommands
}

function collectLinearMethodNames(instancePrototype: object): string[] {
  const names = new Set<string>()
  let prototype: object | null = instancePrototype
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name.startsWith('linear')) {
        names.add(name)
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return [...names]
}

function installMethods(
  target: object,
  source: object,
  field: 'linearCommands' | 'linearBrowseCommands'
): void {
  for (const name of collectLinearMethodNames(source)) {
    const method = {
      [name](this: LinearFacadeInstance, ...args: unknown[]): unknown {
        const commands = this[field] as unknown as Record<string, (...values: unknown[]) => unknown>
        return commands[name](...args)
      }
    }[name]
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: method
    })
  }
}

export function installRuntimeLinearCommandSurface(target: object): void {
  installMethods(target, RuntimeLinearCommands.prototype, 'linearCommands')
  installMethods(target, RuntimeLinearBrowseCommands.prototype, 'linearBrowseCommands')
}
