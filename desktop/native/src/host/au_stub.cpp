// Audio Units exist only on Apple platforms.
#include "plugin.h"
namespace daw3 {
std::unique_ptr<PluginFormat> makeAuFormat() { return nullptr; }
}  // namespace daw3
