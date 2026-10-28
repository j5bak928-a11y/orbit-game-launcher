// Orbit Windows process inventory. No network, elevation, injection, or game manipulation.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <cstdio>
#include <string>
#include <vector>

int main() {
  std::vector<DWORD> pids(16384);
  DWORD needed = 0;
  if (!EnumProcesses(pids.data(), static_cast<DWORD>(pids.size()*sizeof(DWORD)), &needed)) return 1;
  const DWORD count = needed / sizeof(DWORD);
  unsigned int written = 0;
  for (DWORD index = 0; index < count; ++index) {
    const DWORD pid = pids[index];
    if (!pid) continue;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) continue;
    wchar_t name[32768];
    DWORD size = static_cast<DWORD>(sizeof(name)/sizeof(name[0]));
    if (QueryFullProcessImageNameW(process, 0, name, &size) && size > 0) {
      const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name,
                                             static_cast<int>(size), nullptr, 0, nullptr, nullptr);
      if (length > 0 && length < 32768) {
        std::string utf8(static_cast<size_t>(length), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name,
                                static_cast<int>(size), utf8.data(), length, nullptr, nullptr) == length) {
          std::fwrite(utf8.data(), 1, utf8.size(), stdout);
          std::fputc('\n', stdout);
          ++written;
        }
      }
    }
    CloseHandle(process);
  }
  return written ? 0 : 2; // Empty results should trigger the existing PowerShell fallback.
}
