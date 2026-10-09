import pytest

from calculator import add, divide, multiply, subtract


def test_add():
    assert add(2, 3) == 5


def test_subtract():
    assert subtract(5, 3) == 2


def test_multiply():
    assert multiply(4, 2.5) == 10


def test_divide():
    assert divide(9, 3) == 3


def test_divide_by_zero_raises_value_error():
    with pytest.raises(ValueError, match="division by zero"):
        divide(1, 0)
