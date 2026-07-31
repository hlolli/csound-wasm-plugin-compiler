export const CPP_MODLOAD_COMPAT_HEADER = String.raw`
#ifndef OPCODE_WASM_MODLOAD_COMPAT_H
#define OPCODE_WASM_MODLOAD_COMPAT_H

#ifdef _PLUGIN_H_
#error "Include <modload.h> before <plugin.h> in browser builds"
#endif

#define plugin opcode_wasm_native_plugin
#include <plugin.h>
#undef plugin

namespace csnd {

void on_load(Csound *);

namespace opcode_wasm {

constexpr std::size_t max_opcodes = 256;
static OENTRY *entries = nullptr;
static std::size_t entry_count = 0;
static bool registration_failed = false;

inline void reset(OENTRY *storage) {
  entries = storage;
  entry_count = 0;
  registration_failed = false;
}

template <typename T>
int32_t add(const char *name, const char *oargs, const char *iargs,
            uint32_t thr, uint32_t flags, int32_t deprec) {
  if (entry_count >= max_opcodes) {
    registration_failed = true;
    return CSOUND_ERROR;
  }

  SUBR initf = nullptr;
  SUBR perf = nullptr;

  if (thr == thread::i || thr == thread::ik || thr == thread::ia) {
    initf = reinterpret_cast<SUBR>(init<T>);
  }

  if (thr == thread::k || thr == thread::ik) {
    perf = reinterpret_cast<SUBR>(kperf<T>);
  } else if (thr == thread::a || thr == thread::ia) {
    perf = reinterpret_cast<SUBR>(aperf<T>);
  }

  entries[entry_count++] = {
    const_cast<char *>(name),
    sizeof(T),
    static_cast<int32_t>(flags),
    const_cast<char *>(oargs),
    const_cast<char *>(iargs),
    initf,
    perf,
    reinterpret_cast<SUBR>(deinit<T>),
    nullptr,
    deprec
  };

  return CSOUND_SUCCESS;
}

}

template <typename T>
int32_t plugin(Csound *, const char *name, const char *oargs,
               const char *iargs, uint32_t thr, uint32_t flags = 0,
               int32_t deprec = 0) {
  return opcode_wasm::add<T>(
    name,
    oargs,
    iargs,
    thr,
    flags,
    deprec
  );
}

template <typename T>
int32_t plugin(Csound *csound, const char *name, uint32_t thr,
               uint32_t flags = 0, int32_t deprec = 0) {
  return plugin<T>(
    csound,
    name,
    T::otypes,
    T::itypes,
    thr,
    flags,
    deprec
  );
}

}

extern "C" {

PUBLIC int64_t csound_opcode_init(CSOUND *csound, OENTRY **out_entries) {
  auto *entries = static_cast<OENTRY *>(
    csound->Calloc(
      csound,
      csnd::opcode_wasm::max_opcodes * sizeof(OENTRY)
    )
  );

  if (entries == nullptr) {
    *out_entries = nullptr;
    return -1;
  }

  csnd::opcode_wasm::reset(entries);
  csnd::on_load(reinterpret_cast<csnd::Csound *>(csound));

  if (csnd::opcode_wasm::registration_failed) {
    *out_entries = nullptr;
    return -1;
  }

  *out_entries = entries;
  return static_cast<int64_t>(
    csnd::opcode_wasm::entry_count * sizeof(OENTRY)
  );
}

PUBLIC int32_t csoundModuleInfo(void) {
  return (
    (CS_VERSION << 16) +
    (CS_SUBVER << 8) +
    static_cast<int32_t>(sizeof(MYFLT))
  );
}

}

#endif
`
