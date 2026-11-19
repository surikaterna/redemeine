# Sourced by the real projection qualification runners.
case "${REDEMEINE_MONGO_MAJOR:-8}" in
  6) MONGO_VERSION="6.0.27" ;;
  8) MONGO_VERSION="8.0.14" ;;
  *) echo 'REDEMEINE_MONGO_MAJOR must be 6 or 8.' >&2; exit 2 ;;
esac
MONGO_IMAGE="mongo:$MONGO_VERSION"
