#define STABLE_DIRECTORY_HELPER_LIBRARY
#include "stable-directory-helper.cc"

int main() {
  if (ToExtendedWindowsPath("C:\\work\\deep") != "\\\\?\\C:\\work\\deep") return 1;
  if (ToExtendedWindowsPath("\\\\server\\share\\deep") != "\\\\?\\UNC\\server\\share\\deep") return 2;
  if (ToExtendedWindowsPath("\\\\?\\C:\\work") != "\\\\?\\C:\\work") return 3;
  if (WindowsPathForDisplay("\\\\?\\C:\\work\\deep") != "C:\\work\\deep") return 4;
  if (WindowsPathForDisplay("\\\\?\\UNC\\server\\share\\deep") != "\\\\server\\share\\deep") return 5;
  return 0;
}
