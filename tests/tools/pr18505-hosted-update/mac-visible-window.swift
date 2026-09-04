import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let expectedPid = Int32(CommandLine.arguments[1]) else {
  fputs("usage: mac-visible-window <pid>\n", stderr)
  exit(2)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  fputs("CGWindowListCopyWindowInfo failed\n", stderr)
  exit(3)
}

let visible = rows.contains { row in
  guard
    let ownerPid = row[kCGWindowOwnerPID as String] as? NSNumber,
    let layer = row[kCGWindowLayer as String] as? NSNumber,
    let alpha = row[kCGWindowAlpha as String] as? NSNumber,
    let bounds = row[kCGWindowBounds as String] as? [String: Any],
    let width = bounds["Width"] as? NSNumber,
    let height = bounds["Height"] as? NSNumber
  else {
    return false
  }
  return ownerPid.int32Value == expectedPid && layer.intValue == 0 && alpha.doubleValue > 0 &&
    width.doubleValue > 0 && height.doubleValue > 0
}

if visible {
  print("visible")
  exit(0)
}
print("not-visible")
exit(1)
