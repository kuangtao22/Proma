/** 固定概览采集协议版本；修改输出 grammar 时必须同步递增。 */
export const SERVER_OPS_OVERVIEW_COMMAND_VERSION = 1

/**
 * Linux 只读概览采集脚本。
 * 脚本不接受外部参数，不写远端文件，也不启动后台或常驻进程。
 */
export const SERVER_OPS_OVERVIEW_COMMAND = String.raw`export LC_ALL=C

sanitize_text() {
  printf '%s' "$1" | tr '\t\r\n' '   '
}

read_os_release_value() {
  awk -F= -v wanted="$1" '
    $1 == wanted {
      value = substr($0, index($0, "=") + 1)
      if (value ~ /^".*"$/) value = substr(value, 2, length(value) - 2)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' /etc/os-release
}

collect_system() {
  hostname_value=$(uname -n) || return 0
  os_name=$(read_os_release_value NAME) || return 0
  os_version=$(read_os_release_value VERSION) || os_version=$(read_os_release_value VERSION_ID) || return 0
  kernel_value=$(uname -r) || return 0
  arch_value=$(uname -m) || return 0
  uptime_seconds=$(awk 'NF >= 1 { print int($1); found = 1; exit } END { if (!found) exit 1 }' /proc/uptime) || return 0
  [ -n "$hostname_value" ] && [ -n "$os_name" ] && [ -n "$os_version" ] && [ -n "$kernel_value" ] && [ -n "$arch_value" ] && [ -n "$uptime_seconds" ] || return 0

  printf 'system\thostname\t%s\n' "$(sanitize_text "$hostname_value")"
  printf 'system\tosName\t%s\n' "$(sanitize_text "$os_name")"
  printf 'system\tosVersion\t%s\n' "$(sanitize_text "$os_version")"
  printf 'system\tkernel\t%s\n' "$(sanitize_text "$kernel_value")"
  printf 'system\tarch\t%s\n' "$(sanitize_text "$arch_value")"
  printf 'system\tuptimeSeconds\t%s\n' "$uptime_seconds"
}

collect_cpu_and_network() {
  cpu_cores=$(awk '/^processor[[:space:]]*:/ { count += 1 } END { if (count < 1) exit 1; print count }' /proc/cpuinfo) || cpu_cores=
  cpu_before=$(awk '/^cpu / { total = 0; for (index = 2; index <= 9; index += 1) total += $index; print total, $5 + $6; found = 1; exit } END { if (!found) exit 1 }' /proc/stat) || cpu_before=
  network_before=$(awk 'NR > 2 {
    separator = index($0, ":")
    if (separator < 1) next
    counters = substr($0, separator + 1)
    sub(/^[[:space:]]+/, "", counters)
    field_count = split(counters, fields, /[[:space:]]+/)
    if (field_count < 9 || fields[1] !~ /^[0-9]+$/ || fields[9] !~ /^[0-9]+$/) next
    receive += fields[1]; transmit += fields[9]; count += 1
  } END { if (count < 1) exit 1; print receive, transmit }' /proc/net/dev) || network_before=
  sleep 0.25 || return 0
  cpu_after=$(awk '/^cpu / { total = 0; for (index = 2; index <= 9; index += 1) total += $index; print total, $5 + $6; found = 1; exit } END { if (!found) exit 1 }' /proc/stat) || cpu_after=
  network_after=$(awk 'NR > 2 {
    separator = index($0, ":")
    if (separator < 1) next
    counters = substr($0, separator + 1)
    sub(/^[[:space:]]+/, "", counters)
    field_count = split(counters, fields, /[[:space:]]+/)
    if (field_count < 9 || fields[1] !~ /^[0-9]+$/ || fields[9] !~ /^[0-9]+$/) next
    receive += fields[1]; transmit += fields[9]; count += 1
  } END { if (count < 1) exit 1; print receive, transmit }' /proc/net/dev) || network_after=
  load_values=$(awk 'NF >= 3 { print $1, $2, $3; found = 1; exit } END { if (!found) exit 1 }' /proc/loadavg) || load_values=

  if [ -n "$cpu_cores" ] && [ -n "$cpu_before" ] && [ -n "$cpu_after" ] && [ -n "$load_values" ]; then
    set -- $cpu_before
    if [ "$#" -eq 2 ]; then cpu_total_before=$1; cpu_idle_before=$2; else cpu_total_before=; cpu_idle_before=; fi
    set -- $cpu_after
    if [ "$#" -eq 2 ]; then cpu_total_after=$1; cpu_idle_after=$2; else cpu_total_after=; cpu_idle_after=; fi
    cpu_usage=$(awk -v total_before="$cpu_total_before" -v idle_before="$cpu_idle_before" -v total_after="$cpu_total_after" -v idle_after="$cpu_idle_after" 'BEGIN { delta = total_after - total_before; idle = idle_after - idle_before; if (delta <= 0 || idle < 0 || idle > delta) exit 1; printf "%.2f", ((delta - idle) * 100) / delta }') || cpu_usage=
    set -- $load_values
    if [ -n "$cpu_usage" ] && [ "$#" -eq 3 ]; then
      printf 'cpu\tcores\t%s\n' "$cpu_cores"
      printf 'cpu\tusagePercent\t%s\n' "$cpu_usage"
      printf 'cpu\tload\t%s\t%s\t%s\n' "$1" "$2" "$3"
    fi
  fi

  if [ -n "$network_before" ] && [ -n "$network_after" ]; then
    set -- $network_before
    if [ "$#" -eq 2 ]; then receive_before=$1; transmit_before=$2; else receive_before=; transmit_before=; fi
    set -- $network_after
    if [ "$#" -eq 2 ]; then receive_after=$1; transmit_after=$2; else receive_after=; transmit_after=; fi
    network_rates=$(awk -v receive_before="$receive_before" -v transmit_before="$transmit_before" -v receive_after="$receive_after" -v transmit_after="$transmit_after" 'BEGIN { receive = receive_after - receive_before; transmit = transmit_after - transmit_before; if (receive < 0 || transmit < 0) exit 1; printf "%.0f %.0f", receive * 4, transmit * 4 }') || network_rates=
    set -- $network_rates
    if [ "$#" -eq 2 ]; then printf 'network\t%s\t%s\n' "$1" "$2"; fi
  fi
}

collect_memory() {
  awk '
    /^MemTotal:/ { total = $2 * 1024; has_total = 1 }
    /^MemAvailable:/ { available = $2 * 1024; has_available = 1 }
    /^Buffers:/ { buffers = $2 * 1024; has_buffers = 1 }
    /^Cached:/ { cached = $2 * 1024; has_cached = 1 }
    /^SReclaimable:/ { reclaimable = $2 * 1024; has_reclaimable = 1 }
    /^SwapTotal:/ { swap_total = $2 * 1024; has_swap_total = 1 }
    /^SwapFree:/ { swap_free = $2 * 1024; has_swap_free = 1 }
    END {
      if (has_total && has_available && has_buffers && has_cached && has_reclaimable && total >= 0 && available >= 0 && available <= total && buffers >= 0 && cached >= 0 && reclaimable >= 0) {
        cache = buffers + cached + reclaimable
        printf "memory\t%.0f\t%.0f\t%.0f\t%.0f\n", total, total - available, available, cache
      }
      if (has_swap_total && has_swap_free && swap_total >= 0 && swap_free >= 0 && swap_free <= swap_total) {
        printf "swap\t%.0f\t%.0f\n", swap_total, swap_total - swap_free
      }
    }
  ' /proc/meminfo
}

collect_filesystems() {
  df_output=$(df -PkT) || return 0
  [ -n "$df_output" ] || return 0
  printf '%s\n' "$df_output" | awk 'NR > 1 {
    device = $1; filesystem = $2; mount_point = $7
    for (column_index = 8; column_index <= NF; column_index += 1) mount_point = mount_point " " $column_index
    gsub(/[\t\r\n]/, " ", device)
    gsub(/[\t\r\n]/, " ", filesystem)
    gsub(/[\t\r\n]/, " ", mount_point)
    usage = $6; sub(/%$/, "", usage)
    printf "filesystem\t%s\t%s\t%s\t%.0f\t%.0f\t%.0f\t%s\n", device, filesystem, mount_point, $3 * 1024, $4 * 1024, $5 * 1024, usage
  }'
}

collect_processes() {
  cpu_processes=$(ps -eo pid=,%cpu=,%mem=,comm= --sort=-%cpu) || return 0
  memory_processes=$(ps -eo pid=,%cpu=,%mem=,comm= --sort=-%mem) || return 0
  [ -n "$cpu_processes" ] && [ -n "$memory_processes" ] || return 0
  # top CPU 5 与 top memory 5 合并后按 PID 去重，最多输出 10 条。
  (
    printf '%s\n' "$cpu_processes" | head -n 5
    printf '%s\n' "$memory_processes" | head -n 5
  ) | awk '!seen_pid[$1]++ {
    name = $4
    for (field_index = 4; field_index <= NF; field_index += 1) {
      if (field_index > 4) name = name " " $field_index
    }
    gsub(/[\t\r\n]/, " ", name)
    printf "process\t%s\t%s\t%s\t%s\n", $1, name, $2, $3
    count += 1
    if (count >= 10) exit
  }'
}

collect_system 2>/dev/null || true
collect_cpu_and_network 2>/dev/null || true
collect_memory 2>/dev/null || true
collect_filesystems 2>/dev/null || true
collect_processes 2>/dev/null || true`
